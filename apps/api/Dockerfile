# The API and the worker, in one image.
#
# Built from the repository root, not from this directory:
#   docker build -f apps/api/Dockerfile -t bba-api .
# The build needs the root lockfile and packages/shared, so the context has to
# be the workspace root.
#
# ## Why one image and two commands
#
# Plan §14 runs api and worker as separate ECS services, and they still do —
# but from the same image with a different command, rather than from two images
# built separately. They are the same codebase and the same `dist`, and two
# builds mean two chances to deploy a worker running different code from the
# API that enqueues its work. That divergence is silent: the queue accepts the
# job and the worker mishandles it. One image makes it impossible.
#
#   api:    node dist/main.js         (the default)
#   worker: node dist/worker/main.js  (override `command` in the task definition)

# Pinned to the major used in CI. Debian rather than Alpine deliberately:
# Prisma's query engine links against OpenSSL, and the musl builds have a
# history of failing at the first query rather than at startup — the worst
# place to find out.
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ── Dependencies ─────────────────────────────────────────────────────────────
# Manifests first, so this layer is reused on every build that does not change
# a dependency. Copying the source here instead would reinstall the whole tree
# on every one-line change.
FROM base AS deps
# tsconfig.base.json is extended by every workspace tsconfig, so a build
# without it fails at the first `tsc` with TS5083 — a missing-file error that
# names a path, not a missing COPY. Found by replaying this build's file set
# outside a container rather than by discovering it in CI.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# The web workspace is installed too, and that is not waste: npm workspaces
# resolve the whole tree at once, and `npm ci` refuses to install a subset
# against a lockfile describing all of it.
RUN npm ci --ignore-scripts

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build
ENV NODE_ENV=development
COPY packages/shared packages/shared
COPY apps/api apps/api

# Generated inside the image, on the image's own platform, so the engine binary
# matches the runtime. Running it on the host instead is how a darwin-arm64
# engine reaches a linux container — see .dockerignore for the other half of
# that trap.
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

RUN npm run build --workspace @bba/shared \
 && npm run build --workspace @bba/api

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

# Removes every dev dependency — TypeScript, vitest, the Playwright client —
# from the tree the image ships. Done here rather than with a second `npm ci`
# so the generated Prisma client, which lives inside node_modules, survives.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
RUN npm prune --omit=dev --workspaces --include-workspace-root

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist

# The schema and migrations ship with the image so a task can run
# `npx prisma migrate deploy` against the same code it is about to serve.
# §14 uses expand-then-contract migrations, which means the migration step and
# the deploy step are separate — and both need this directory.
COPY --from=build /app/apps/api/prisma ./apps/api/prisma

WORKDIR /app/apps/api

# `node` exists in the base image; running as root is a default worth losing.
USER node

# 3001 is the API. 9464 and 9465 are the metrics ports for the api and worker
# commands respectively — separate listeners the load balancer must not route
# to, exposed here only so a scraper inside the VPC can reach them.
EXPOSE 3001 9464 9465

# Exec form, so node is PID 1 and receives SIGTERM directly. Both entry points
# handle it: the API through Nest's shutdown hooks, the worker by stopping the
# scheduler and draining in-flight jobs. A shell wrapper here would swallow the
# signal and leave ECS to SIGKILL mid-request.
CMD ["node", "dist/main.js"]
