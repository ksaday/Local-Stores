import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request ambient state (plan §12.11). Carried in AsyncLocalStorage so log
 * lines and audit entries pick up requestId/userId/storeId without every
 * function signature having to thread them through.
 *
 * This is for observability and audit. It is NOT the tenant-isolation
 * mechanism — that is the RLS transaction context in infra/prisma, which is set
 * explicitly per transaction. Do not be tempted to read storeId from here to
 * scope a query.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  storeId?: string;
  isSuperAdmin: boolean;
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Mutates the active context. Used by guards once identity is established. */
export function setContextIdentity(patch: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, patch);
}
