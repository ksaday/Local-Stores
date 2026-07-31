# BBA v2

Multi-tenant SaaS eCommerce platform for small local businesses — *"Local Shops, Online
Stores Near You."* Built per the architecture and planning document set in
[`docs/plan/`](docs/plan/README.md), which is the source of truth for every decision
here: read it before making changes that contradict it, and record any deviation as an ADR.

## Product decisions (settled)

| | |
|---|---|
| **Scope** | Retail commerce only for v2.0. Service-business threads, internal messaging, and accounting deferred to v2.1 ([§17](docs/plan/17-future-enhancements.md)) |
| **Pricing** | $49 per store per month, 30-day free trial. Single plan — no tiers in v2.0 ([§18.5a](docs/plan/18-final-recommendations.md)) |
| **Launch market** | Illinois, concentrated on Chicago and its suburbs. Lower 48 eventually — tax sits behind a `TaxProvider` interface so expansion is a swap, not a migration ([§18.5b](docs/plan/18-final-recommendations.md)) |
| **Store onboarding** | SuperAdmin-operated AI opening agent, in-app ([§19](docs/plan/19-ai-onboarding-agent.md)) |
| **Migration** | None needed — no live stores on the predecessor. Fresh build with seeded fixtures |
| **Still open** | Whether to take a per-transaction fee on top of the subscription ([§18.6](docs/plan/18-final-recommendations.md)) — must be decided before Phase 8 |

A predecessor Firebase MVP (BBA3) exists locally and is not part of this repository. It
implemented and validated every workflow described in the plan, and is the reason these
requirements are specific rather than speculative ([§18.2](docs/plan/18-final-recommendations.md)).

## Status

**Phase 1 (Foundation) + first slice of Phase 3 (Tenancy) in progress.**

Done so far:
- Monorepo scaffold: `apps/web` (not yet started), `apps/api`, `apps/worker` (not yet started), `packages/shared`, `packages/ui` (not yet started)
- `packages/shared`: permission catalog + guardrails, order state machine, error codes — all with passing unit tests
- `apps/api`: initial Prisma schema (users, stores, store_memberships, permission overrides, refresh_tokens)
- **PostgreSQL Row-Level Security policies applied and verified** — the cross-tenant isolation suite (`apps/api/src/infra/prisma/tenant-isolation.test.ts`) passes against the restricted `bba_app` role, proving store A cannot read or write store B's data even through a bug in application code
- Local dev environment: Postgres 16 + Redis via Homebrew (not Docker — no Docker Desktop on this machine; `docker-compose.yml` can be added later for portability)

Not started: NestJS API server itself (controllers/services/guards), Next.js web app, worker, catalog/inventory/orders/payments schema, everything in Phases 4-12.

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

1. NestJS bootstrap in `apps/api`: guards (`JwtAuthGuard`, `StoreScopeGuard`,
   `PermissionsGuard`), the `auth` module (register/login/refresh), wired to the
   `packages/shared` permission catalog.
2. Extend the Prisma schema with the remaining Phase 3 tables as each later phase needs
   them, rather than all 40+ tables up front — schema grows with the roadmap.
3. Next.js app in `apps/web` with the four route groups from
   `docs/plan/11-frontend-architecture.md` §11.1.
4. Do not start Phase 4 (store management) until the auth + permission guard from step 1
   has its own test coverage — every later phase depends on it being right.
