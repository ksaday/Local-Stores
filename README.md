# BBA v2

Enterprise-target rebuild of BBA per the architecture and planning document set at
[`../BBA3/docs/plan/`](../BBA3/docs/plan/README.md) (the source of truth for every
decision here — read it before making changes that contradict it, and record any
deviation as an ADR).

**Scope:** retail commerce only for v2.0 launch (service-business threads, internal
messaging, and accounting are deferred to v2.1 — see `docs/plan/17-future-enhancements.md`).
No BBA3 store migration is needed (no live stores yet) — this is a fresh build, seeded
with fixtures, not an ETL target.

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

## Why no Docker

This machine doesn't have Docker installed, and installing Docker Desktop needs a GUI
install + password that shouldn't happen without you present. Homebrew Postgres/Redis
are a fine substitute for solo local dev. A `docker-compose.yml` (matching
`docs/plan/07-system-architecture.md`) should be added before onboarding a second
developer or wiring CI, since CI will want ephemeral, disposable service containers
rather than a shared local install.

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
