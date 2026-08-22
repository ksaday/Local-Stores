# Container images

Three services, two images.

| Service | Image | Command |
|---|---|---|
| api | `apps/api/Dockerfile` | `node dist/main.js` (default) |
| worker | *the same image* | `node dist/worker/main.js` |
| web | `apps/web/Dockerfile` | `node apps/web/server.js` |

Both are built **from the repository root**, because the build needs the root
lockfile, `tsconfig.base.json` and `packages/shared`:

```bash
docker build -f apps/api/Dockerfile -t bba-api .
docker build -f apps/web/Dockerfile -t bba-web .
```

Or run the whole stack from the real images:

```bash
docker compose --profile apps up --build
```

The profile matters: without it `docker compose up` still starts only Postgres
and Redis, which is what you want while writing code.

---

## Why the api and the worker share one image

They are the same codebase and the same `dist`. Building them separately gives
two chances to deploy a worker whose code differs from the API enqueuing its
work, and that divergence is **silent** — the queue accepts the job and the
worker mishandles it. One image makes it impossible. Plan §14 still runs them
as separate ECS services; they just point at the same image with a different
`command`.

## Migrations

The schema and `prisma/migrations` ship inside the API image, and the Prisma
CLI is a production dependency rather than a dev one so it survives the prune.
That is deliberate: §14 uses expand-then-contract migrations, so the migration
runs as its own task, and it must run from *the same image* as the code that
depends on it. A migration task built separately from the service is how a
schema change and the code expecting it end up out of step.

```bash
# as a one-off task, same image, different command
npx prisma migrate deploy
```

## Traps these images already avoid

Each of these was hit, or would have been, and the comment in the Dockerfile
says so at the point it matters.

**A macOS Prisma engine in a Linux container.** The query engine is
platform-specific — `libquery_engine-darwin-arm64.dylib.node` locally. If a
host `node_modules` is copied in, or `prisma generate` runs outside the image,
the container fails at its first *query*, not at startup. `.dockerignore`
excludes `node_modules` and the generate runs inside the build.

**`tsconfig.base.json`.** Every workspace tsconfig extends it, and a build
without it fails with TS5083 naming a path rather than a missing `COPY`.

**Next's static assets.** `.next/static` is deliberately *not* part of the
standalone output. Miss the second copy and the server starts, answers, and
every page renders with no CSS and no JavaScript — which reads as a styling bug
rather than a packaging one.

**`outputFileTracingRoot`.** npm hoists dependencies to the root
`node_modules`. Without pointing tracing at the workspace root, Next traces from
`apps/web`, finds almost nothing, and produces a standalone build missing its
own dependencies — a failure that only appears when the container starts.

**`HOSTNAME=0.0.0.0`.** Next's standalone server binds loopback by default, so
the container would answer only itself and fail every health check from outside.

**Signals.** Both images use exec-form `CMD`, so node is PID 1 and gets
`SIGTERM` directly — the API through Nest's shutdown hooks, the worker by
stopping its scheduler and draining in-flight jobs. A shell wrapper would
swallow the signal and leave the orchestrator to `SIGKILL` mid-request.

---

## What has and has not been verified

There is no container runtime on the machine these were written on, so **the
images have not been built**. That is the gap to close first on any machine
with Docker: `docker build` both, then `docker compose --profile apps up`.

Everything the images *do* was verified by replaying it outside a container:

- the exact file set each stage copies is enough to `npm ci`, `prisma generate`
  and build both workspaces — this is what caught the missing
  `tsconfig.base.json`
- after `npm prune --omit=dev`, the remaining tree boots **both** entry points,
  serves a real query against Postgres, and exposes its metrics port
- `prisma migrate deploy` runs from that pruned tree (28 migrations found)
- the standalone output plus `.next/static` serves the homepage and its hashed
  JavaScript chunk

What that leaves genuinely unproven is container-specific: base image contents,
the Linux Prisma engine actually being the one generated, layer caching, and
whether anything in the build reaches for a file only present on a developer
machine.
