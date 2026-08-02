# Local Stores

*"Local Shops, Online Stores Near You."*

Multi-tenant SaaS eCommerce platform for small local businesses. Internally the platform
is referred to as **BBA (Business Bridge App)** throughout the planning documents; this
repository is v2, the production rebuild. Built per the architecture and planning document set in
[`docs/plan/`](docs/plan/README.md), which is the source of truth for every decision
here: read it before making changes that contradict it, and record any deviation as an ADR.

## Product decisions (settled)

| | |
|---|---|
| **Scope** | Retail commerce only for v2.0. Service-business threads, internal messaging, and accounting deferred to v2.1 ([§17](docs/plan/17-future-enhancements.md)) |
| **Pricing** | $49 per store per month, 30-day free trial. Single plan — no tiers in v2.0 ([§18.5a](docs/plan/18-final-recommendations.md)) |
| **Transaction fee** | **None.** BBA takes no cut of a store's sales — `application_fee_amount` is omitted from PaymentIntents entirely, and the commitment is stated in-product. Revenue is the subscription alone ([§18.6](docs/plan/18-final-recommendations.md)) |
| **Launch market** | Illinois, concentrated on Chicago and its suburbs. Lower 48 eventually — tax sits behind a `TaxProvider` interface so expansion is a swap, not a migration ([§18.5b](docs/plan/18-final-recommendations.md)) |
| **Store onboarding** | SuperAdmin-operated AI opening agent, in-app ([§19](docs/plan/19-ai-onboarding-agent.md)) |
| **Migration** | None needed — no live stores on the predecessor. Fresh build with seeded fixtures |

All product decisions are settled; none are outstanding. The full decision log with
consequences is [§18.5](docs/plan/18-final-recommendations.md).

A predecessor Firebase MVP (BBA3) exists locally and is not part of this repository. It
implemented and validated every workflow described in the plan, and is the reason these
requirements are specific rather than speculative ([§18.2](docs/plan/18-final-recommendations.md)).

## Status

**Phases 2, 4, 5, 7 and 8 complete.** 345 tests passing. A shop can list
products, take an order online or over the counter, work the queue, take cash
or card, refund, and print a receipt.

### Done

**Foundation** — monorepo (`apps/api`, `packages/shared`), NestJS with a
validated-at-boot config, RFC 9457 Problem Details, response envelope, zod
validation, AsyncLocalStorage request context.

**Tenancy** — PostgreSQL RLS on every table, enforced through a per-request
transaction context. The cross-tenant isolation suite runs as the restricted
`bba_app` role and is the release gate.

**Auth** — argon2id, EdDSA access tokens with membership claims, refresh
rotation with family-wide revocation on replay, email verification, password
reset, staff invitations, session management, TOTP MFA with recovery codes,
Google OAuth account linking.

**Authorization** — three guards registered globally so routes are protected by
default. Store-scoped permissions resolve from membership + guardrailed
overrides; `platform:*` permissions check platform role instead.

**Store management** — public applications, Super Admin review and
provisioning, lifecycle transitions, hours, tax rates, delivery zones with
serviceability checks, branding with WCAG AA contrast validation, staff
management, media upload pipeline, append-only audit log.

**Catalog** — categories with a depth limit, products with variants and
images, per-store SKU uniqueness, Postgres full-text search over name and
brand, publish as a permission distinct from edit.

**Storefront** — public store directory with trigram fuzzy search, per-store
themed landing pages, category browsing, filtering and sorting, product detail,
JSON-LD, sitemap and robots. Every read is anonymous and RLS-enforced.

**Cart & checkout** — per-store carts for guests and signed-in shoppers,
merged on sign-in; line revalidation against the live catalog; a quote engine
with a `TaxProvider` seam; the order-creation transaction with stock
reservation, per-store order numbers and idempotency; the order state machine
with role-gated transitions; cash payment; the PENDING expiry sweeper.

**Inventory (the checkout-critical part)** — `stock_levels` derived from an
append-only `stock_movements` ledger, with reservation semantics. Receiving,
count sessions and low-stock alerts belong to the inventory phase and are not
built.

**Order queue** — the staff screen. Orders grouped by what the shop has to do
next rather than by time, one-tap status actions sized for a tablet, the order
workbench with items, contact, payment and full history, and cash collection.
Actions are derived from the same state machine the API enforces, so the UI
never offers a button the server will refuse — a delivery driver sees "out for
delivery" on a ready order and no cancel button at all.

**Till (POS)** — walk-in sales. Barcode scan or typed SKU with a name-search
fallback, a tap grid for shops without a scanner, cash tender with change, and
a sale that lands as a completed, paid order. Stock leaves through the same
ledger online orders use, so there is one path out of inventory rather than
two that can disagree.

**Print documents** — a receipt sized for an 80mm thermal roll and a pick list
for whoever packs the bag. Plain black-on-white CSS: receipt printers are
monochrome, so anything relying on colour or hairlines prints as mud.

**Live queue (SSE)** — the staff queue updates itself as orders arrive and
change, via a Server-Sent Events stream proxied through the BFF. Events carry
no order contents: they only prompt a re-read, so the database stays the single
authority and a duplicated or dropped event costs at most a redundant refresh.
Falls back to 15-second polling after two failures, and says which mode it is
in — a screen staff rely on has to admit when it has stopped updating.

**Payments (Stripe)** — Connect Express onboarding, so identity and bank
details go to Stripe directly and never touch this platform. Destination
charges settle to the store's own account with `application_fee_amount`
omitted entirely. Webhooks verify the signature, record the event, and handle
it once — a replay loses the unique insert and is skipped. Refunds route
through the account that took the original payment, are written PENDING and
confirmed by webhook, and a database trigger refuses any that would exceed what
was captured. Cash works whether or not Stripe is configured.

**Web** — Next.js App Router BFF: auth flows, the Super Admin console, store
settings and staff management, the public storefront, the customer purchase
flow (cart, checkout, card payment, receipt), the staff order queue, and the
till.

### Not started

- `apps/worker` — BullMQ; media processing and mail currently run inline, and
  order events are an in-process bus rather than the outbox in plan §12.8 (see
  `order-events.service.ts` for what that costs)
- Coupons/promotions and catalog CSV import/export (rest of Phase 5)
- Geocoding, so delivery addresses can be matched to a zone. Checkout says
  plainly that it cannot place an address rather than guessing a fee.
- **Stripe against real keys.** Everything is built and tested against a fake
  provider plus locally-signed webhooks, and the signature path is verified
  end-to-end with a genuine HMAC — but no request has ever reached Stripe.
  Walk one order through onboarding → card → refund with test keys before
  trusting it.
- Stripe Billing — the $49/month subscription itself. Customer payments work;
  charging *stores* does not exist yet.
- Phases 6 and 9–12: the rest of inventory, delivery, reporting, hardening,
  deployment
- OAuth HTTP handshake (the Google redirect/callback glue). The account-linking
  logic underneath it is built and tested; only the provider round-trip is
  missing, and it needs real Google credentials to exercise.

## Things worth knowing before you change anything

**The API must not connect as the schema owner.** `DATABASE_URL` is the
migration identity and is typically a superuser; **superusers bypass RLS
entirely**, even with `FORCE ROW LEVEL SECURITY`. The API ran on that
connection for several phases, which meant every policy in the schema was
switched off at runtime while the whole test suite passed — the tests connect
as `bba_app` explicitly, so they were testing a configuration the server was
not using. Nothing errors when this is wrong; queries just quietly return rows
they should not. The runtime now uses `DATABASE_URL_APP` (see
`infra/prisma/prisma.module.ts`) and refuses to boot without it outside
development.

To check a running server, ask it for a resource that RLS should hide — a
guest order without its claim token should 404, not 200.

**`prisma.unscoped()` is almost always wrong.** Four separate bugs so far have
had the identical shape: a query written before anyone considered whose data it
was, silently returning or affecting zero rows under RLS, with no exception.
They would have shipped as "login is impossible", "no staff member has any
permission", and an expiry sweeper that reported success while sweeping nothing
and holding stock off the shelf forever. A cross-tenant job wants
`withTenant({ isSuperAdmin: true })`, not `unscoped()`.
`src/infra/prisma/unscoped-usage.test.ts` confines the escape hatch to files
that genuinely need it — extend that list deliberately, with a reason.

**`INSERT ... RETURNING` applies the SELECT policy.** Prisma always emits
RETURNING, so `create()` fails on any row written where the writer cannot read
it back — audit entries, invitation tokens with a null user, media rows. Use a
raw INSERT for those. Widening the read policy instead would expose data.

**The migration chain must rebuild the database from nothing.** It drifted
once: a failed run left the ledger stuck, later migrations were applied by
hand, and two migration files had a Prisma update-notice box captured into
them by a redirect — so `migrate deploy` could not run at all while the dev
database looked fine. Verify with a throwaway database rather than trusting
the ledger:

```bash
createdb bba_check && DATABASE_URL="postgresql://$(whoami)@localhost:5432/bba_check?schema=public" npx prisma migrate deploy
```

Then diff it against dev. `prisma migrate diff` does not compare RLS policies
or functions, which is where most of this schema's security lives — compare
`pg_policies` and `pg_proc` directly.

**`ON CONFLICT DO UPDATE` checks CHECK constraints before it detects the
conflict.** The stock trigger originally upserted with
`INSERT … ON CONFLICT (variant_id) DO UPDATE SET on_hand = on_hand + delta`.
PostgreSQL evaluates the proposed row's CHECK constraints *before* the
speculative insertion that finds the conflict, so every sale — a negative delta
— failed `on_hand >= 0` against a row that would never have been stored. Update
first, insert only `IF NOT FOUND`.

**An SSE heartbeat must be an event, not a comment.** The stream originally
sent `: ping` to keep proxies from closing it. That works for the socket and is
useless to the client: `EventSource` never surfaces comment lines to
JavaScript. When the API died mid-stream the browser went on reporting a
healthy connection — the queue showed "Updating live" over data that had
stopped moving, which is worse than showing nothing. The server now sends both
a comment and a named `heartbeat` event, and the client treats silence longer
than 60s as failure. Testing this needs a **foregrounded** tab: browsers
throttle background timers hard, which is also why `visibilitychange` triggers
its own liveness check.

**Client-side money must round exactly like the server.** The till showed a
running total by applying the tax rate to the subtotal, while the server
applies it per line and sums. On some baskets those differ by a cent — the
clerk reads "change $6.30", hands it over, and the receipt says $6.29. Any
screen that displays a total before the server computes one has to use the
same rounding, not merely an approximation of it (`ConfiguredRateTaxProvider`
is the reference).

**`GRANT` is additive; append-only needs `REVOKE`.** Migration 1 sets
`ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE`, so every
table created afterwards starts fully mutable by `bba_app` and a narrower
`GRANT` in a later migration changes nothing. `audit_logs`, `stock_movements`
and `order_status_history` each carry an explicit
`REVOKE UPDATE, DELETE … FROM bba_app`. Enforce this at the grant level rather
than with a trigger: a trigger also blocks the owner, which makes retention
purges impossible.

**A `FOR ALL` policy governs deletes, not just reads.** Adding a public branch
to a `FOR ALL` policy's `USING` clause makes those rows publicly *deletable* —
`USING` decides which rows an UPDATE or DELETE may touch, not only which rows
are visible. Tables with public read access split it in two: a `FOR SELECT`
policy carrying the public branch, and a `FOR ALL` write policy without it.
`media_assets` was migrated to this shape in `00000000000009`.

**Public visibility is three conditions, not one.** For media: not private,
finished processing, and owned by a live store. Dropping any one of them
publishes delivery proofs, unvalidated uploads, or a store that hasn't
launched. An attach-time check cannot replace the policy — an asset can be
rejected *after* it was attached to a live product.

**`GRANT` is additive; append-only needs `REVOKE`.** Migration 1 sets
`ALTER DEFAULT PRIVILEGES`, so every new table starts fully mutable by
`bba_app` and a narrower `GRANT` in a later migration adds nothing. Tables that
must only accumulate — `stock_movements`, `order_status_history`, `audit_logs`,
`refunds` — carry an explicit `REVOKE UPDATE, DELETE`.

**Prisma reports raw-query errors as `P2010`, with the real code in `meta`.**
`$executeRaw` never surfaces `P2002`, so a unique-violation check written only
against the top-level code silently misses every raw insert — which is exactly
where it matters: idempotency keys, webhook event ids, order numbers. Use
`isUniqueViolation` from `infra/prisma/prisma-errors.ts`.

**Mounting a body parser by hand disables Nest's global one.** Nest skips
registering its parser if it detects one already present, so a path-scoped
`express.json({ verify })` for webhook raw bodies leaves *every other route*
with an undefined body. Use `NestFactory.create(App, { rawBody: true })`.

**`application_fee_amount` must be absent, not zero.** BBA takes no cut of any
sale, and a zero fee still prints a fee line on the store's Stripe statement.
`stripe.provider.test.ts` asserts the field never appears in the outbound
request — it is a product promise, not a convention.

**Pre-identity reads go through SECURITY DEFINER functions.** Login, refresh,
redeeming a mailed token, OAuth identity lookup, recovery codes. Each takes an
exact-match credential and returns at most one row, so none can enumerate.
Adding a sixth deserves the scrutiny of widening an RLS policy.

**Auth tests run as `bba_app`, not the superuser.** A superuser bypasses RLS
entirely, so they would pass against a configuration that cannot work in
production. The storefront tests do the same, with no identity set at all —
that is the only way to prove what the public can actually see.

**Tests must own globally unique slugs, and seed their own fixtures.** A
fixture that collides with seeded data passes on an empty database and fails on
a working one — storefront fixtures are prefixed `test-` for this reason. The
opposite failure is worse: the isolation gate once depended on rows that
existed only in one developer's database, so on a fresh clone its negative
assertions ("store B is invisible") all passed while proving nothing. It now
seeds its fixtures and asserts they exist before checking anything is hidden.

**Media is served from the API origin, not the web origin.** `MEDIA_BASE_URL`
is unset in development and the API serves `.storage/public` itself. Two
things this depends on: the static mount points at `public/` specifically —
mounting `.storage` would publish the sibling `private/` and `quarantine/`
directories — and the route overrides helmet's `Cross-Origin-Resource-Policy`
to `cross-origin`, without which the browser refuses to render every image
while `curl` fetches them happily.

## Local development

Prerequisites: Postgres 16 and Redis running via Homebrew.

```bash
brew services start postgresql@16
brew services start redis
```

Install and generate:

```bash
npm install
cd apps/api && cp .env.example .env && npx prisma generate && npx prisma migrate deploy
```

Seed a themed store with a catalog, tax rate, delivery zone, stock and a
staff login, so both the storefront and the order queue have something real to
work with. It prints the URLs and the sign-in it created:

```bash
cd apps/api && npm run seed:dev
```

Run both servers (the API first — the web app proxies to it):

```bash
npm run dev --workspace @bba/api
```

```bash
npm run dev --workspace @bba/web
```

The storefront is then at `/stores` and the seeded shop at
`/stores/morse-ave-bakery`. Sign in with the credentials the seed printed to
reach that store's order queue and watch an order you place arrive in it.

To exercise card payments, put Stripe test keys in `apps/api/.env` and forward
webhooks — `stripe listen` prints the signing secret to paste back:

```bash
stripe listen --forward-to localhost:3001/api/v1/webhooks/stripe
```

Without those keys the platform runs cash-only: card checkout is not offered,
rather than failing at the moment a customer tries to pay.

Run tests:

```bash
npm run test          # all workspaces
npm run typecheck      # all workspaces
```

Run just the tenant-isolation gate (this must always pass — it's the release gate from
`docs/plan/12-backend-architecture.md` §12.12):

```bash
cd apps/api && npm run test:isolation
```

## Why Homebrew services instead of Docker

The plan ([§14.2](docs/plan/14-deployment-architecture.md)) calls for docker-compose in
local dev. This repo currently uses Homebrew Postgres and Redis instead, because Docker
wasn't installed on the machine this was scaffolded on and Docker Desktop needs an
interactive install.

**This is a known gap, not a decision.** Add a `docker-compose.yml` matching
§7.1 before onboarding a second developer or wiring CI — CI needs ephemeral, disposable
service containers, not a shared local install.

## Next steps (in order)

1. **Run Stripe against real test keys.** The whole payment path is built and
   tested against a fake provider, and signature verification is proven with a
   genuine HMAC — but nothing has yet talked to Stripe. Walk one order through
   onboarding → card → refund before trusting it.
2. **`apps/worker`** — the event outbox (§12.8) and the PENDING expiry sweeper
   need a process to run in. Order events are in-process today, so the live
   queue is single-instance only.
3. **Stripe Billing** — the $49/month subscription. Customer payments work;
   charging stores does not exist.
4. **`docker-compose.yml`** — before a second developer or CI (see above).
5. **Rest of Phase 5** — coupons and promotions, catalog CSV import/export.
6. **OAuth HTTP handshake** — the Google redirect and callback, wired to the
   already-tested linking logic. Needs real Google credentials.

Before starting a phase, read its entry in `docs/plan/15-development-roadmap.md`
and the risk register in §16. Record any deviation from the plan as an ADR
rather than letting the code and the documents drift apart.
