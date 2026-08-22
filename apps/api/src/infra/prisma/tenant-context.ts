// Tenant-context transaction wrapper. See docs/plan/12-backend-architecture.md §12.4
// and docs/plan/08-database-schema.md §8.6.
//
// Every request's DB work MUST go through withTenantContext. A repository call
// made outside it runs with empty RLS context and returns zero foreign rows —
// failing closed. This is deliberate: the smoke test in this phase's commit
// message showed exactly why (set_config is transaction-local; forgetting the
// wrapper silently drops the context, not silently leaks data).
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { PrismaClient, Prisma } from "@prisma/client";

export interface TenantContext {
  userId?: string;
  storeId?: string;
  isSuperAdmin: boolean;

  /**
   * Opaque guest cart key, from a cookie. Lets someone shop before they have
   * an account, which most first-time customers will do.
   *
   * It is an identity for RLS purposes and nothing else: it grants access to
   * one cart, never to orders, and never to anything store-scoped.
   */
  sessionKey?: string;

  /**
   * Claim token for a guest's order, from their receipt link. Grants read
   * access to exactly the one order it belongs to.
   *
   * Deliberately separate from `sessionKey`: a cart key is long-lived and
   * lives in a cookie on a shared device, so it must not also unlock past
   * purchases.
   */
  guestToken?: string;
}

/**
 * The tracer for database work.
 *
 * `@opentelemetry/api` with no SDK registered hands back a no-op tracer, so
 * this costs nothing at all when tracing is switched off — which is the normal
 * state in tests and on a laptop.
 */
const tracer = trace.getTracer("bba.db");

/**
 * Which RLS context this transaction ran under — four values, no identifiers.
 *
 * Worth distinguishing because the four behave differently under RLS and
 * therefore perform differently: a platform-scoped read skips the policies
 * entirely, and an anonymous one matches almost nothing. Seeing which kind a
 * slow transaction was is most of the diagnosis.
 */
function tenantScope(ctx: TenantContext): string {
  if (ctx.isSuperAdmin) return "platform";
  if (ctx.storeId) return "store";
  if (ctx.userId) return "user";
  return "anonymous";
}

export function withTenantContext<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // One span per tenant-scoped transaction, and this is the right unit to
  // measure in this codebase rather than a compromise for lack of a driver
  // instrumentation. RLS context is transaction-local, so the transaction *is*
  // the boundary that decides which rows exist and what the planner does with
  // them — ADR 0003 is an entire document about that. A trace showing "this
  // request spent 400ms inside one store-scoped transaction" points at the
  // right thing; a list of individual statements would not.
  return tracer.startActiveSpan(
    "db.transaction",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "postgresql",
        // The tenant dimension, and nothing that identifies a person. A user id
        // is deliberately absent: §4 keeps identifying data out of the trace
        // backend, and the store is enough to find the shop a slow query
        // belongs to.
        "bba.tenant.scope": tenantScope(ctx),
        ...(ctx.storeId ? { "bba.store_id": ctx.storeId } : {}),
      },
    },
    async (span) => {
      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT
            set_config('app.user_id', ${ctx.userId ?? ""}, true),
            set_config('app.store_id', ${ctx.storeId ?? ""}, true),
            set_config('app.is_super_admin', ${String(ctx.isSuperAdmin)}, true),
            set_config('app.session_key', ${ctx.sessionKey ?? ""}, true),
            set_config('app.guest_token', ${ctx.guestToken ?? ""}, true)`;
          return work(tx);
        });
        return result;
      } catch (err) {
        // Marks the span failed so the tail sampler keeps the whole trace —
        // a query that threw is the single most useful thing to have a trace of.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
