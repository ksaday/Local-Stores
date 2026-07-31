# 12. Backend Architecture

`apps/api` — NestJS 11, TypeScript strict, Prisma, PostgreSQL, Redis/BullMQ. A **modular monolith**: one deployable, hard internal boundaries (§7.2).

## 12.1 Module map

```
apps/api/src/
  main.ts                     bootstrap: helmet, CORS, versioning, global pipes/filters
  common/                     guards, interceptors, filters, decorators, pagination
  infra/
    prisma/                   PrismaService + tenant-context client extension
    redis/  queue/  storage/  mailer/  stripe/  telemetry/
  modules/
    auth/                     register, login, refresh rotation, MFA, OAuth, invitations
    users/                    profile, addresses, sessions, data export/deletion
    memberships/              staff invites, roles, permission overrides, resolution
    stores/                   profile, hours, zones, taxes, branding, lifecycle
    catalog/                  categories, products, variants, images, coupons
    inventory/                stock levels, movement ledger, receiving, counts
    carts/                    cart lifecycle, guest merge
    checkout/                 quote, order creation, reservation, coupon application
    orders/                   state machine, queue, POS, returns, print docs
    payments/                 Stripe Connect, cash, refunds, webhook handlers
    deliveries/               assignment, status, proof of delivery
    reviews/                  verified-purchase reviews, replies, moderation
    notifications/            event → channel fan-out, preferences, in-app inbox
    reports/                  SQL aggregations, rollups, CSV exports
    platform/                 applications, store lifecycle, users, plans, audit, config, health
    events/                   domain event bus + transactional outbox
    health/                   liveness, readiness, dependency probes
```

Boundary rule enforced by ESLint: a module may import another module's **public service interface** only — never its repository, never its Prisma models directly. Cross-module reactions go through domain events, not direct calls. This is what keeps a future extraction (notifications, deliveries) a refactor rather than a rewrite.

## 12.2 Layering

```
Controller   HTTP only: DTO validation (zod), permission decorators, response shaping
    ↓
Service      Business rules, transactions, domain event emission. No HTTP, no SQL strings
    ↓
Repository   Prisma queries; the only layer that touches the ORM
    ↓
PostgreSQL   Constraints, triggers, RLS — the last line of defense
```

Controllers never touch Prisma; services never read `req`. DTOs are zod schemas from `packages/shared`, so the frontend validates against the identical contract (NFR-MNT-02).

## 12.3 Request pipeline

```
Request
 → Helmet + CORS
 → RequestContext (AsyncLocalStorage: requestId, ip, userAgent)
 → RateLimitGuard        (Redis sliding window, §10.1)
 → JwtAuthGuard          (verify access token, load claims)
 → StoreScopeGuard       (resolve :storeId, assert membership, load store)
 → PermissionsGuard      (@RequirePermission — effective set from Redis cache)
 → ZodValidationPipe     (body/query/params)
 → IdempotencyInterceptor (money-moving POSTs)
 → Controller → Service (inside tenant-scoped transaction)
 → ResponseEnvelopeInterceptor  → AuditInterceptor  → ProblemDetailsFilter
```

`@Public()` opts a route out of auth; every non-decorated route is protected by default (FR-AUTHZ-06).

## 12.4 Tenant context propagation

The single most important mechanism in the backend. A Prisma client extension wraps each request's work in a transaction that first sets the RLS context (§8.6):

```ts
// infra/prisma/tenant.extension.ts (shape, not final code)
export function withTenantContext<T>(
  prisma: PrismaClient,
  ctx: { userId?: string; storeId?: string; isSuperAdmin: boolean },
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT
      set_config('app.user_id',        ${ctx.userId ?? ''},  true),
      set_config('app.store_id',       ${ctx.storeId ?? ''}, true),
      set_config('app.is_super_admin', ${String(ctx.isSuperAdmin)}, true)`;
    return work(tx);
  });
}
```

`set_config(..., true)` is transaction-local, so context cannot leak across pooled connections. Services obtain the transaction client from request scope; a repository that queries outside this wrapper hits RLS with empty context and returns nothing — failing closed, loudly, in tests rather than quietly in production.

## 12.5 Permission resolution

```ts
effective(userId, storeId):
  1. Redis GET perms:{userId}:{storeId}          // 5 min TTL
  2. miss → membership (status=ACTIVE) + overrides
  3. roleDefaults(role) ∪ GRANTs − DENYs
  4. validate GRANTs ⊆ allowedSuperset(role)     // guardrail, §4.4
  5. cache + return
```

Cache invalidated on membership change, override change, or suspension — plus the 5 min ceiling, which bounds worst-case propagation (FR-AUTHZ-07). Super admins bypass store permission checks but still pass through `platform:*` checks and are always audited.

## 12.6 Transaction boundaries (the flows that must be atomic)

**Checkout** (`checkout.service.createOrder`) — one transaction:

1. Lock cart, re-price every line (prices/stock may have moved since quote).
2. `SELECT … FOR UPDATE` on each `stock_levels` row → verify `on_hand − reserved ≥ qty` → increment `reserved`.
3. Validate coupon (window, limits, per-customer count) and insert `coupon_redemptions`.
4. Increment `store_counters` → order number.
5. Insert `orders` + `order_items` (snapshots) + initial `order_status_history`.
6. Insert `payments` row (PENDING).
7. Emit `order.created` to the outbox.

Commit, *then* call Stripe (never hold a DB transaction across a network call to an external provider). If the PaymentIntent call fails, the order stays PENDING and the expiry sweeper releases the reservation.

**Payment confirmation** (webhook) — one transaction: mark payment SUCCEEDED, order → CONFIRMED, convert `reserved` → `on_hand` decrement with `SALE` ledger movements, upsert `customer_store_relations`, emit `order.confirmed`. Idempotent on `stripe_event_id`.

**Refund**: insert refund PENDING → call Stripe → webhook flips to SUCCEEDED and transitions the order. Never mark refunded on the optimistic path.

**Inventory receive/adjust/count**: insert movements; trigger updates `stock_levels` in the same transaction. On-hand is never written directly by application code.

## 12.7 Order state machine

Defined once in `packages/shared`:

```ts
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING:          ['CONFIRMED', 'CANCELLED'],
  CONFIRMED:        ['PREPARING', 'CANCELLED'],
  PREPARING:        ['READY', 'CANCELLED'],
  READY:            ['PICKED_UP', 'OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'READY'],
  PICKED_UP:        ['RETURNED'],
  DELIVERED:        ['RETURNED'],
  CANCELLED:        ['REFUNDED'],
  RETURNED:         ['REFUNDED'],
  REFUNDED:         [],
};
```

`orders.service.transition()` checks the map, then the actor's permission for that specific edge (§5.1 table), then applies side effects (stock release on cancel, delivery creation on READY+DELIVERY, notification events), then appends to `order_status_history`. A DB trigger rejects illegal enum jumps as a backstop — the state machine is enforced twice on purpose.

## 12.8 Domain events & the outbox

Services emit domain events inside their transaction by inserting into an `outbox_events` table (id, type, payload, published_at). A relay worker polls unpublished rows and enqueues BullMQ jobs, then marks them published. This gives **exactly-once-ish** semantics: an event is never lost because the DB committed but Redis was down, and never fired for a transaction that rolled back.

Event catalog (consumers in brackets): `order.created` [notifications, SSE], `order.confirmed` [notifications, inventory, customer relations, SSE], `order.status_changed` [notifications, deliveries, SSE], `order.cancelled` [inventory release, payments], `payment.succeeded|failed` [orders, notifications], `refund.succeeded` [orders, reports], `inventory.low_stock` [notifications], `delivery.assigned|status_changed` [notifications, orders, SSE], `review.created` [store rating recompute], `store.approved|suspended` [notifications, cache invalidation], `member.invited|suspended` [permission cache bust, notifications].

## 12.9 Workers (`apps/worker`)

Same codebase, different entrypoint — imports the API's domain services so business rules exist in exactly one place. Queues per §7.6. Every processor is idempotent, retries ×5 with exponential backoff, and dead-letters to a queue surfaced on `/platform/health`. Scheduled jobs: PENDING order expiry (1 min), low-stock scan (15 min), daily sales rollup (nightly), stock-ledger reconciliation (nightly), token/soft-delete purge (daily), abandoned-cart marking (hourly).

## 12.10 External integrations

| Integration | Design |
|-------------|--------|
| **Stripe** | `infra/stripe` wraps the SDK; per-store operations always pass the store's connected account. Destination charges with **`application_fee_amount` omitted entirely** — BBA takes no cut of sales, and the effective rate resolves to 0 for every store ([§18.6](18-final-recommendations.md#186-transaction-fee--zero-and-stated-publicly)). Omit rather than pass zero, so no fee line appears on the store's statement; a test asserts this holds. Webhooks: verify signature → persist `stripe_events` row (unique id) → enqueue → handler is idempotent |
| **Payments abstraction** | A `PaymentProvider` interface (`createIntent`, `capture`, `refund`, `onboardAccount`) with a Stripe implementation. Square/PayPal (FR-PAY-08) implement the same interface without touching order logic |
| **Email/SMS/Push** | `NotificationChannel` interface with SES/Twilio/WebPush implementations; templates (MJML → HTML) rendered in the worker with store branding |
| **Storage** | Presigned S3 uploads; the API never proxies image bytes. Post-upload validation pipeline in §13.7 |
| **Geocoding** | Address → lat/lng for store addresses and delivery zone checks, behind a `GeocodingProvider` interface (Mapbox default), results cached in Redis |

## 12.11 Configuration, logging, health

- **Config**: zod-validated env schema; the app refuses to boot on missing/invalid config. Secrets from SSM/Secrets Manager, never files in the image.
- **Logging**: Pino JSON with `requestId`, `userId`, `storeId` auto-injected from AsyncLocalStorage; a redaction list scrubs tokens, passwords, card-ish fields, and full addresses from logs (NFR-OPS-01).
- **Tracing**: OpenTelemetry auto-instrumentation for HTTP, Prisma, Redis, and Stripe calls; trace id shares the request id.
- **Health**: `/health/live` (process), `/health/ready` (DB, Redis, S3, Stripe reachability) — drives ECS target-group health checks and the platform health page.

## 12.12 Testing

| Level | Tool | Scope |
|-------|------|-------|
| Unit | Jest | State machine, pricing/tax/coupon math, permission resolution, zone geometry |
| Integration | Jest + Testcontainers (real Postgres + Redis) | Every module's endpoints against real constraints, triggers, and **RLS policies** |
| Isolation suite | Jest | Cross-tenant probes: for each tenant table, store A's token attempting store B's rows must 403/404 and return zero rows. **Blocks release** (NFR-SEC-01) |
| Contract | OpenAPI diff in CI | Breaking API change without a version bump fails the build |
| Load | k6 | Checkout, order queue, catalog browse at 2× NFR-SCL targets |
