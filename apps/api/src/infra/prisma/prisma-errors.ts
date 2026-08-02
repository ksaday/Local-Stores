/**
 * Recognises a unique-constraint violation from Prisma.
 *
 * Prisma reports the same database error two different ways depending on how
 * the query was issued, and only one of them is obvious:
 *
 * - Through the query builder (`create`, `update`): `code === "P2002"`.
 * - Through `$executeRaw`: `code === "P2010"` — a generic "raw query failed" —
 *   with the real Postgres SQLSTATE tucked inside `meta.code`.
 *
 * Checking only the top-level code silently misses every raw insert, which is
 * exactly where this matters most: idempotency keys, webhook event ids and
 * order numbers are all written raw, and each relies on catching the conflict
 * to return the first result instead of failing a retry.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;

  const candidate = err as { code?: string; meta?: { code?: string } };
  if (candidate.code === "P2002") return true;

  // 23505 is the SQLSTATE for unique_violation.
  return candidate.meta?.code === "23505" || candidate.code === "23505";
}
