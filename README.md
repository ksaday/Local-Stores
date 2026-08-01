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

**Phase 2 (Auth & RBAC) complete. Phase 4 (Store management) API complete.**
159 tests passing. `apps/web` is not started — everything below is API-only.

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

### Not started

- `apps/web` (Next.js) — all four route groups from plan §11.1
- `apps/worker` — BullMQ; media processing and mail currently run inline
- Phases 5–12: catalog, inventory, cart/checkout/orders, payments, delivery,
  reporting, hardening, deployment
- OAuth HTTP handshake (the Google redirect/callback glue). The account-linking
  logic underneath it is built and tested; only the provider round-trip is
  missing, and it needs real Google credentials to exercise.

## Things worth knowing before you change anything

**`prisma.unscoped()` is almost always wrong.** Three separate bugs in Phase 2
had the identical shape: a query written before anyone considered whose data it
was, silently returning or affecting zero rows under RLS, with no exception.
Two would have shipped as "login is impossible" and "no staff member has any
permission". `src/infra/prisma/unscoped-usage.test.ts` confines it to files
that genuinely need it — extend that list deliberately, with a reason.

**`INSERT ... RETURNING` applies the SELECT policy.** Prisma always emits
RETURNING, so `create()` fails on any row written where the writer cannot read
it back — audit entries, invitation tokens with a null user, media rows. Use a
raw INSERT for those. Widening the read policy instead would expose data.

**Pre-identity reads go through SECURITY DEFINER functions.** Login, refresh,
redeeming a mailed token, OAuth identity lookup, recovery codes. Each takes an
exact-match credential and returns at most one row, so none can enumerate.
Adding a sixth deserves the scrutiny of widening an RLS policy.

**Auth tests run as `bba_app`, not the superuser.** A superuser bypasses RLS
entirely, so they would pass against a configuration that cannot work in
production.

## Local development

Prerequisites: Postgres 16 and Redis running via Homebrew.

```bash
brew services start postgresql@16
brew services start redis
```

Install and generate:

```bash
npm install
cd apps/api && cp .env.example .env && npx prisma generate
```

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

1. **`apps/web`** — the Next.js app, per plan §11.1's four route groups. This is
   the largest remaining gap: everything built so far is API-only, and the
   platform review console and store settings UI are Phase 4 deliverables that
   have no frontend yet.
2. **Phase 5 (Catalog)** — categories, products, variants, public storefront
   browsing with SEO. Depends on the media pipeline, which is done.
3. **OAuth HTTP handshake** — the Google redirect and callback, wired to the
   already-tested linking logic. Needs real Google credentials.
4. **`docker-compose.yml`** — before a second developer or CI (see above).

Before starting a phase, read its entry in `docs/plan/15-development-roadmap.md`
and the risk register in §16. Record any deviation from the plan as an ADR
rather than letting the code and the documents drift apart.
