// Tenant-context transaction wrapper. See docs/plan/12-backend-architecture.md §12.4
// and docs/plan/08-database-schema.md §8.6.
//
// Every request's DB work MUST go through withTenantContext. A repository call
// made outside it runs with empty RLS context and returns zero foreign rows —
// failing closed. This is deliberate: the smoke test in this phase's commit
// message showed exactly why (set_config is transaction-local; forgetting the
// wrapper silently drops the context, not silently leaks data).
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

export function withTenantContext<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT
      set_config('app.user_id', ${ctx.userId ?? ""}, true),
      set_config('app.store_id', ${ctx.storeId ?? ""}, true),
      set_config('app.is_super_admin', ${String(ctx.isSuperAdmin)}, true),
      set_config('app.session_key', ${ctx.sessionKey ?? ""}, true),
      set_config('app.guest_token', ${ctx.guestToken ?? ""}, true)`;
    return work(tx);
  });
}
