import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards `PrismaService.unscoped()`.
 *
 * Three separate RLS bugs during Phase 2 all had the same shape: a query was
 * written before anyone thought about whose data it was, `unscoped()` was the
 * path of least resistance, and under the restricted app role the query
 * silently returned or affected zero rows. None of them threw. Two would have
 * shipped as "login is impossible" and "no staff member has any permission";
 * the third left superseded invitation links working.
 *
 * `unscoped()` is legitimate in exactly two situations:
 *   1. Pre-identity reads — login, refresh, redeeming a mailed token — where
 *      the caller has no identity yet to scope to. These go through narrow
 *      SECURITY DEFINER functions.
 *   2. Platform-wide administration, which is explicitly cross-tenant.
 *
 * Everywhere else it is a bug waiting to be discovered in production. This test
 * fails when a new file reaches for it, forcing the author to either scope the
 * query or add the file here deliberately.
 */
const ALLOWED = new Set([
  // The complete inventory of pre-identity reads (login, refresh).
  "src/modules/auth/auth.repository.ts",
  // Verification tokens: redeeming a link from an inbox is pre-identity by
  // definition. Reads and invalidation go through SECURITY DEFINER functions.
  "src/modules/auth/verification-token.service.ts",
  // Defines unscoped() itself.
  "src/infra/prisma/prisma.service.ts",
  // This test names it.
  "src/infra/prisma/unscoped-usage.test.ts",
]);

/**
 * Known remaining call sites, to be scoped rather than grandfathered.
 * Shrinking this list is the point; adding to it needs a reason in review.
 */
const KNOWN_DEBT = new Set([
  // Reads a store name to render an invitation preview for an unauthenticated
  // invitee. Safe (public store data) but should move behind a narrow lookup.
  "src/modules/auth/invitation.service.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("PrismaService.unscoped() usage", () => {
  it("is confined to files that legitimately need it", () => {
    // __dirname is src/infra/prisma; the package root is three levels up.
    const root = join(__dirname, "../../..");
    const offenders = walk(join(root, "src"))
      .filter((file) => readFileSync(file, "utf8").includes(".unscoped()"))
      .map((file) => relative(root, file).replace(/\\/g, "/"))
      .filter((rel) => !ALLOWED.has(rel) && !KNOWN_DEBT.has(rel));

    expect(
      offenders,
      `These files call prisma.unscoped(), which bypasses tenant scoping and ` +
        `silently returns zero rows under RLS.\n` +
        `Use prisma.withTenant({ userId, storeId }) instead. If the query is ` +
        `genuinely pre-identity or platform-wide, add it to ALLOWED in this ` +
        `file with a comment explaining why.\n\n` +
        `Offenders:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has a shrinking debt list, not a growing one", () => {
    // A ratchet: this number may go down, never up. If a change needs a new
    // unscoped() call site, scope the query instead.
    expect(KNOWN_DEBT.size).toBeLessThanOrEqual(1);
  });
});
