# 10. API Specification

REST over HTTPS, JSON only. Base path `/api/v1`. OpenAPI 3.1 spec generated from NestJS decorators and published at `/api/docs` (staging) — this document is the human-readable contract; the generated spec is the machine-readable one.

## 10.1 Conventions

### Versioning

URL-path versioned (`/api/v1/...`). A new major version ships only for breaking changes; additive fields are not breaking. Two majors run concurrently for ≥ 6 months. Deprecations announce via `Sunset` and `Deprecation` response headers.

### Authentication

| Client | Mechanism |
|--------|-----------|
| Web (browser) | httpOnly `bba_at` (access, 15 min) + `bba_rt` (refresh, 30 d, path-scoped to `/api/v1/auth`) cookies, `SameSite=Lax`, `Secure` |
| Native / server | `Authorization: Bearer <access_token>`, refresh via `POST /auth/refresh` |

Access token claims:

```json
{
  "sub": "user-uuid",
  "email": "kim@example.com",
  "platformRole": null,
  "memberships": [
    { "storeId": "store-uuid", "role": "CLERK" },
    { "storeId": "other-uuid", "role": "STORE_ADMIN" }
  ],
  "iat": 1753900000, "exp": 1753900900, "jti": "..."
}
```

Effective permissions are **not** in the token (they change too often and would bloat it) — the API resolves them per request from Redis-cached membership data (§7.5).

### Tenant scoping

Store-scoped resources are nested under `/stores/{storeId}`. The guard verifies `storeId` against the caller's memberships before any handler runs; the resolved store also sets the RLS transaction context (§8.6). Public storefront reads use the slug (`/public/stores/{slug}`) and require no auth.

### Standard request headers

| Header | Purpose |
|--------|---------|
| `Idempotency-Key` | Required on `POST /checkout/orders`, refunds, and POS sales. 24 h replay window returns the original response |
| `X-Request-Id` | Client-supplied correlation ID; echoed on the response and stamped on every log line |
| `Accept-Language` | Reserved for i18n (v2.x) |

### Response envelope

Single resource:

```json
{ "data": { "id": "...", "...": "..." } }
```

Collection with pagination:

```json
{
  "data": [ { "id": "..." } ],
  "meta": { "page": 1, "pageSize": 25, "total": 314, "totalPages": 13 },
  "links": { "next": "/api/v1/stores/{id}/orders?page=2&pageSize=25", "prev": null }
}
```

Cursor pagination (used for high-volume feeds: orders, movements, audit logs):

```json
{ "data": [ ], "meta": { "nextCursor": "eyJpZCI6..." , "hasMore": true } }
```

### Pagination, filtering, sorting

| Param | Form | Example |
|-------|------|---------|
| Page | `?page=2&pageSize=25` (max 100) | |
| Cursor | `?cursor=<opaque>&limit=50` | |
| Sort | `?sort=-placedAt,orderNumber` (`-` = desc; whitelisted fields only) | |
| Filter | `?status=CONFIRMED,PREPARING` (CSV = OR) | |
| Range | `?placedAt[gte]=2026-07-01&placedAt[lt]=2026-08-01` | |
| Search | `?q=espresso` (module-defined fields) | |
| Sparse fields | `?fields=id,orderNumber,status,totalCents` | |
| Expand | `?expand=items,payments` (whitelisted relations, max depth 1) | |

### Errors

RFC 9457 Problem Details, plus a stable machine `code`:

```json
{
  "type": "https://bba.app/errors/insufficient-stock",
  "title": "Insufficient stock",
  "status": 409,
  "code": "INVENTORY_INSUFFICIENT",
  "detail": "Only 2 units of 'Sourdough Loaf / Large' remain.",
  "instance": "/api/v1/checkout/orders",
  "requestId": "req_01J...",
  "errors": [
    { "field": "items[0].qty", "code": "MAX", "message": "Requested 5, available 2" }
  ]
}
```

| Status | When |
|--------|------|
| 200 / 201 / 202 / 204 | OK / created / accepted (async job queued) / no content |
| 400 | Malformed request |
| 401 | Missing/expired token |
| 403 | Authenticated but lacks permission, or wrong tenant |
| 404 | Not found **or** hidden by tenancy (never disclose existence across tenants) |
| 409 | State conflict: illegal status transition, insufficient stock, duplicate SKU |
| 410 | Resource expired (checkout session, invitation token) |
| 422 | Semantically invalid: guardrail violation, coupon not applicable |
| 423 | Account locked |
| 429 | Rate limited (`Retry-After`, `X-RateLimit-*` headers) |
| 500 / 503 | Unhandled / dependency unavailable |

Error codes are exported from `packages/shared` so the frontend maps them to user-facing copy without string matching.

### Idempotency & concurrency

- Mutating endpoints that create money movement require `Idempotency-Key`; the key + request hash is stored 24 h in Redis. Same key + same body → cached response; same key + different body → `409 IDEMPOTENCY_KEY_REUSED`.
- Updates to long-lived entities (products, store settings) support optimistic concurrency via `If-Match: <etag>`; mismatch → `412 Precondition Failed`.

### Rate limits (per identity, sliding window — see §13.5)

| Bucket | Limit |
|--------|-------|
| `auth:login`, `auth:register`, `auth:forgot` | 10 / 15 min per IP + per account |
| Public catalog reads | 300 / min per IP |
| Authenticated general | 1000 / min per user |
| Checkout & payments | 20 / min per user |
| Webhooks (Stripe) | unlimited, signature-verified |

## 10.2 Endpoint inventory

Permission column: required permission string (§4.2); **own** = ownership check; **public** = no auth.

### Auth — `/api/v1/auth`

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/register` | Create account, send verification | public |
| POST | `/login` | Issue token pair | public |
| POST | `/refresh` | Rotate refresh token (FR-AUTH-04) | refresh cookie |
| POST | `/logout` | Revoke current session | any |
| POST | `/verify-email` | Consume verification token | public |
| POST | `/resend-verification` | Re-send email | any |
| POST | `/forgot-password` | Send reset link (always 202, no user enumeration) | public |
| POST | `/reset-password` | Consume reset token, revoke all sessions | public |
| POST | `/change-password` | Requires current password | any |
| GET | `/me` | Profile + memberships + platform role | any |
| GET | `/sessions` | Active sessions | own |
| DELETE | `/sessions/{id}` · `/sessions` | Revoke one / all | own |
| POST | `/mfa/setup` · `/mfa/verify` · `/mfa/disable` | TOTP lifecycle | own |
| GET | `/oauth/google` · `/oauth/google/callback` | Social login | public |
| POST | `/invitations/{token}/accept` | Staff/owner joins store | public (token) |

### Public storefront — `/api/v1/public` (no auth, CDN-cacheable)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/stores` | Directory: `?q=&businessType=&near=lat,lng&radiusKm=&page=` |
| GET | `/stores/{slug}` | Storefront profile: branding, hours, open-now, zones summary, rating |
| GET | `/stores/{slug}/categories` | Category tree |
| GET | `/stores/{slug}/products` | Listing: `?q=&categoryId=&priceMin=&priceMax=&inStock=&sort=` |
| GET | `/stores/{slug}/products/{productSlug}` | Detail: variants, images, stock badge, reviews summary |
| GET | `/stores/{slug}/products/{productId}/reviews` | Paginated reviews |
| POST | `/store-applications` | Owner applies (FR-PLAT-01) |

### Customer — `/api/v1/me`

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| PATCH | `/profile` | Name, phone, avatar | own |
| GET/POST | `/addresses` · PATCH/DELETE `/addresses/{id}` | Address book | own |
| GET | `/carts` | All active carts (one per store) | own |
| GET/POST | `/carts/{storeId}/items` | View / add line | own |
| PATCH/DELETE | `/carts/{storeId}/items/{itemId}` | Change qty / remove | own |
| POST | `/carts/{storeId}/merge` | Merge guest session cart after login | own |
| GET | `/orders` | Cross-store history `?storeId=&status=&placedAt[gte]=` | own |
| GET | `/orders/{id}` | Detail + timeline + proof of delivery | own |
| POST | `/orders/{id}/cancel` | Cancel or request cancellation (FR-ORD-05) | own |
| GET | `/orders/{id}/receipt` | Receipt payload (HTML/PDF render server-side) | own |
| GET/POST/DELETE | `/wishlist` · `/wishlist/{productId}` | Wishlist | own |
| GET/POST/DELETE | `/favorites` · `/favorites/{storeId}` | Favorite stores | own |
| POST | `/reviews` | Verified-purchase review | own |
| PATCH/DELETE | `/reviews/{id}` | Edit / remove own review | own |
| GET | `/notifications` · POST `/notifications/{id}/read` · POST `/notifications/read-all` | In-app inbox | own |
| GET/PUT | `/notification-preferences` | Channel prefs | own |
| POST/DELETE | `/push-subscriptions` | Web push registration | own |
| GET | `/export` · DELETE `/account` | GDPR/CCPA data export, account closure | own |

### Checkout — `/api/v1/checkout`

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/quote` | Price the cart: lines, discount, tax, delivery fee, zone validation. No side effects | customer |
| POST | `/orders` | Create order + reserve stock + create PaymentIntent. `Idempotency-Key` required | customer |
| POST | `/orders/{id}/retry-payment` | New PaymentIntent for a still-PENDING order | own |
| GET | `/delivery-zones/check` | `?storeId=&lat=&lng=` → serviceable + fee + ETA | any |
| POST | `/coupons/validate` | Validate code against a cart | customer |

### Store operations — `/api/v1/stores/{storeId}`

**Profile & settings**

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/` | `store:read` |
| PATCH | `/` | `store:settings` |
| PATCH | `/branding` | `store:branding` |
| GET/PUT | `/hours` · `/special-hours` | `store:read` / `store:settings` |
| GET/POST/PATCH/DELETE | `/delivery-zones[/{id}]` | `store:settings` |
| GET/POST/PATCH/DELETE | `/tax-rates[/{id}]` | `store:settings` |
| GET | `/payment-settings` | `store:payments-config` |
| PATCH | `/payment-settings` | `store:payments-config` |
| POST | `/stripe/onboarding-link` | `store:payments-config` — returns Connect onboarding URL |
| GET | `/stripe/status` | `store:payments-config` — charges/payouts enabled |
| GET | `/subscription` · POST `/subscription/change-plan` | `store:settings` |

**Staff**

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/members` | `staff:read` |
| POST | `/members/invitations` | `staff:manage` — email invite with role |
| DELETE | `/members/invitations/{id}` | `staff:manage` |
| PATCH | `/members/{id}` | `staff:manage` — role or status |
| GET/PUT | `/members/{id}/permissions` | `staff:manage` — guardrailed overrides (§4.4); out-of-superset grant → 422 |
| DELETE | `/members/{id}` | `staff:manage` — suspends, never deletes the user |

**Catalog**

| Method | Path | Permission |
|--------|------|-----------|
| GET/POST | `/categories` · PATCH/DELETE `/categories/{id}` | `catalog:read` / `catalog:write` |
| GET | `/products` | `catalog:read` — `?q=&status=&categoryId=&lowStock=true` |
| POST | `/products` | `catalog:write` — creates default variant |
| GET/PATCH/DELETE | `/products/{id}` | `catalog:read` / `catalog:write` (soft delete) |
| POST | `/products/{id}/publish` · `/archive` | `catalog:publish` |
| GET/POST | `/products/{id}/variants` · PATCH/DELETE `/variants/{id}` | `catalog:write` |
| POST | `/products/{id}/images` | `catalog:write` — attaches uploaded asset |
| PATCH | `/products/{id}/images/reorder` | `catalog:write` |
| POST | `/products/import` · GET `/products/export` | `catalog:write` — CSV, async (202 + job id) |
| GET | `/products/lookup` | `catalog:read` — `?barcode=` or `?sku=` for POS/scanning |
| GET/POST/PATCH/DELETE | `/coupons[/{id}]` | `coupons:read` / `coupons:manage` |

**Inventory**

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/inventory` | `inventory:read` — levels + availability, `?lowStock=true` |
| GET | `/inventory/movements` | `inventory:read` — cursor-paginated ledger |
| POST | `/inventory/receive` | `inventory:receive` — `{ lines: [{variantId, qty, note}] }` |
| POST | `/inventory/adjust` | `inventory:adjust` — requires `reasonCode` |
| PATCH | `/inventory/{variantId}/settings` | `inventory:adjust` — reorder point, expected qty/ETA |
| POST | `/inventory/counts` · GET `/inventory/counts/{id}` | `inventory:count` |
| PUT | `/inventory/counts/{id}/items` | `inventory:count` — enter counted quantities |
| POST | `/inventory/counts/{id}/post` | `inventory:count` — posts variance movements |

**Orders**

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/orders` | `orders:read` — queue: `?status=&fulfillment=&channel=&q=` |
| GET | `/orders/{id}` | `orders:read` |
| POST | `/orders/{id}/transition` | `orders:manage` — `{ to: "PREPARING", note? }`; illegal → 409 |
| POST | `/orders/{id}/cancel` | `orders:cancel` — `{ reason, restock: true }` |
| POST | `/orders/{id}/return` | `orders:manage` — `{ items:[{orderItemId, qty, restock, damaged}] }` |
| POST | `/orders/{id}/refunds` | `orders:refund` — full/partial, `Idempotency-Key` |
| POST | `/orders/{id}/cash-received` | `payments:collect-cash` |
| POST | `/orders/pos` | `orders:create-pos` — walk-in sale, `Idempotency-Key` |
| GET | `/orders/{id}/print/{docType}` | `orders:read` — `receipt` \| `pick-list` |

**Delivery**

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/deliveries` | `delivery:read-all` — board view |
| GET | `/deliveries/mine` | `delivery:read-own` — driver's queue |
| POST | `/deliveries/{id}/assign` | `delivery:assign` — `{ membershipId }` |
| POST | `/deliveries/{id}/status` | `delivery:update-own` — `{ status, lat?, lng? }` |
| POST | `/deliveries/{id}/proof` | `delivery:update-own` — `{ photoAssetId?, signatureAssetId? }`, ≥1 required |
| POST | `/deliveries/{id}/fail` | `delivery:update-own` — `{ reason }` → order back to READY |

**Customers, reviews, reports**

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/customers` | `customers:read` — store's customer list + LTV |
| GET | `/customers/{userId}` | `customers:read` — orders at this store only |
| GET | `/reviews` · POST `/reviews/{id}/reply` · POST `/reviews/{id}/report` | `reviews:read` / `reviews:reply` / `reviews:report` |
| GET | `/reports/sales` | `reports:sales` — `?from=&to=&groupBy=day\|week\|month&channel=` |
| GET | `/reports/products` | `reports:sales` — top products/categories |
| GET | `/reports/inventory` | `reports:inventory` — valuation, low stock, movement summary |
| GET | `/reports/taxes` · `/reports/refunds` | `reports:sales` |
| GET | `/reports/customers` | `reports:sales` |
| GET | `/reports/staff` | `reports:staff` |
| POST | `/reports/{type}/export` | matching report permission — 202 + job, emailed/downloadable CSV |
| GET | `/dashboard` | `store:read` — KPI bundle for FR-DASH-01 (single call, permission-filtered) |

**Media**

| Method | Path | Permission |
|--------|------|-----------|
| POST | `/media/upload-url` | `catalog:write` \| `store:branding` \| `delivery:update-own` — presigned S3 PUT, returns `assetId` |
| POST | `/media/{assetId}/complete` | same — triggers validation + processing pipeline (§13.7) |

### Platform — `/api/v1/platform` (SUPER_ADMIN only)

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/dashboard` | `platform:stores` — GMV, MRR, counts, health |
| GET | `/applications` · POST `/applications/{id}/approve` · `/reject` | `platform:stores` |
| GET | `/stores` · GET `/stores/{id}` | `platform:stores` |
| POST | `/stores/{id}/suspend` · `/reactivate` · `/close` | `platform:stores` |
| POST | `/stores/{id}/transfer-ownership` | `platform:stores` |
| GET | `/users` · GET `/users/{id}` | `platform:users` |
| POST | `/users/{id}/lock` · `/unlock` · `/force-password-reset` | `platform:users` |
| GET | `/subscriptions` · PATCH `/stores/{id}/plan` | `platform:billing` |
| GET | `/plans` · POST/PATCH `/plans[/{code}]` | `platform:config` |
| GET | `/audit-logs` | `platform:audit` — `?actorId=&storeId=&entityType=&action=&from=&to=` (cursor) |
| GET/POST | `/announcements` | `platform:announce` |
| GET/PUT | `/settings` | `platform:config` — fees, limits, feature flags |
| GET | `/health` | `platform:config` — queue depth, webhook failures, error rates |
| POST | `/stores/{id}/impersonate` | `platform:impersonate` — read-only scoped token, audit-logged (FR-AUTHZ-08) |

### Webhooks — `/api/v1/webhooks`

| Method | Path | Notes |
|--------|------|-------|
| POST | `/stripe` | Signature-verified (`stripe-signature`), raw-body parsed. Handles `payment_intent.succeeded\|payment_failed`, `charge.refunded`, `charge.dispute.created`, `account.updated`, `invoice.payment_failed`, `customer.subscription.*`. Persists event id → enqueues → **idempotent** (duplicate ids no-op). Always 200 on receipt unless signature invalid (400) |

## 10.3 Worked examples

### Create order (checkout)

```http
POST /api/v1/checkout/orders
Authorization: Bearer <access>
Idempotency-Key: 6f1c9b2a-...
Content-Type: application/json

{
  "storeId": "b6c1...",
  "cartId": "c0aa...",
  "fulfillment": "DELIVERY",
  "addressId": "a91d...",
  "couponCode": "WELCOME10",
  "tipCents": 200,
  "paymentMethod": "CARD",
  "customerNote": "Ring the side bell"
}
```

```http
HTTP/1.1 201 Created
Location: /api/v1/me/orders/9d2e...

{
  "data": {
    "id": "9d2e...",
    "orderNumber": "SUN-1042",
    "status": "PENDING",
    "fulfillment": "DELIVERY",
    "subtotalCents": 4200,
    "discountCents": 420,
    "taxCents": 312,
    "deliveryFeeCents": 500,
    "tipCents": 200,
    "totalCents": 4794,
    "currency": "USD",
    "expiresAt": "2026-07-30T18:02:11Z",
    "payment": {
      "provider": "STRIPE",
      "clientSecret": "pi_3P..._secret_...",
      "publishableKey": "pk_live_..."
    }
  }
}
```

Failure (stock moved between quote and submit):

```http
HTTP/1.1 409 Conflict

{
  "type": "https://bba.app/errors/insufficient-stock",
  "title": "Insufficient stock",
  "status": 409,
  "code": "INVENTORY_INSUFFICIENT",
  "detail": "Some items are no longer available in the requested quantity.",
  "requestId": "req_01J...",
  "errors": [
    { "field": "items[1].qty", "code": "MAX", "message": "Requested 3, available 1" }
  ]
}
```

### Advance an order (clerk)

```http
POST /api/v1/stores/b6c1.../orders/9d2e.../transition
{ "to": "READY", "note": "Bagged, on pickup shelf 3" }
```

```json
{
  "data": {
    "id": "9d2e...",
    "status": "READY",
    "history": [
      { "toStatus": "PENDING",   "at": "2026-07-30T17:32:11Z", "actor": null },
      { "toStatus": "CONFIRMED", "at": "2026-07-30T17:32:29Z", "actor": null },
      { "toStatus": "PREPARING", "at": "2026-07-30T17:35:02Z", "actor": "Kim (Clerk)" },
      { "toStatus": "READY",     "at": "2026-07-30T17:41:55Z", "actor": "Kim (Clerk)" }
    ]
  }
}
```

Illegal transition:

```json
{
  "type": "https://bba.app/errors/invalid-transition",
  "title": "Invalid status transition",
  "status": 409,
  "code": "ORDER_INVALID_TRANSITION",
  "detail": "Cannot move an order from READY to CONFIRMED.",
  "allowedTransitions": ["PICKED_UP", "OUT_FOR_DELIVERY", "CANCELLED"]
}
```

### Receive stock

```http
POST /api/v1/stores/b6c1.../inventory/receive
{
  "reference": "PO-2291",
  "lines": [
    { "variantId": "v1...", "qty": 24 },
    { "variantId": "v2...", "qty": 12, "note": "2 crushed, see damage entry" }
  ]
}
```

```json
{
  "data": {
    "movements": [
      { "id": "m1...", "variantId": "v1...", "type": "RECEIVE", "qtyDelta": 24, "onHandAfter": 31 },
      { "id": "m2...", "variantId": "v2...", "type": "RECEIVE", "qtyDelta": 12, "onHandAfter": 12 }
    ],
    "lowStockCleared": ["v1..."]
  }
}
```

### Sales report

```http
GET /api/v1/stores/b6c1.../reports/sales?from=2026-07-01&to=2026-07-31&groupBy=day
```

```json
{
  "data": {
    "range": { "from": "2026-07-01", "to": "2026-07-31" },
    "totals": {
      "ordersCount": 412, "grossCents": 1842300, "discountsCents": 71200,
      "taxCents": 132400, "refundsCents": 24500, "netCents": 1746600,
      "averageOrderValueCents": 4471
    },
    "byChannel": { "ONLINE": { "ordersCount": 331 }, "POS": { "ordersCount": 81 } },
    "series": [
      { "date": "2026-07-01", "ordersCount": 12, "netCents": 51200 },
      { "date": "2026-07-02", "ordersCount": 17, "netCents": 73900 }
    ]
  }
}
```

## 10.4 Real-time updates

Order queues and customer tracking need push, not polling:

- **Server-Sent Events** at `GET /api/v1/stores/{storeId}/events` (staff) and `GET /api/v1/me/events` (customer). Auth via cookie/bearer; the stream is filtered by permission and tenancy.
- Event types mirror domain events: `order.created`, `order.status_changed`, `delivery.status_changed`, `inventory.low_stock`, `notification.created`.
- SSE chosen over WebSockets: one-directional, works through standard HTTP infrastructure, trivially reconnects with `Last-Event-Id`. Client falls back to 15 s polling if the stream drops twice.
