// Permission catalog and role defaults. See docs/plan/04-roles-permissions.md §4.2-§4.4.
//
// This is the single source of truth consumed by:
//   - apps/api PermissionsGuard (server-side enforcement, authoritative)
//   - apps/web RequirePermission (UI gating only — never the real check)
// Both must import from here rather than re-declaring role logic.
import type { MembershipRole } from "./roles.js";

export const PERMISSIONS = [
  "store:read",
  "store:settings",
  "store:branding",
  "store:payments-config",
  "staff:read",
  "staff:manage",
  "catalog:read",
  "catalog:write",
  "catalog:publish",
  "inventory:read",
  "inventory:receive",
  "inventory:adjust",
  "inventory:count",
  "orders:read",
  "orders:manage",
  "orders:create-pos",
  "orders:cancel",
  "orders:refund",
  "payments:collect-cash",
  "payments:read",
  "delivery:read-own",
  "delivery:read-all",
  "delivery:update-own",
  "delivery:assign",
  "customers:read",
  "customers:message",
  "coupons:read",
  "coupons:manage",
  "reports:sales",
  "reports:inventory",
  "reports:staff",
  "reviews:read",
  "reviews:reply",
  "reviews:report",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Default permission bundle granted to each store-scoped role (§4.3). */
export const ROLE_DEFAULT_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  STORE_ADMIN: PERMISSIONS, // full store-scoped surface
  INVENTORY_MANAGER: [
    "store:read",
    "catalog:read",
    "catalog:write",
    "inventory:read",
    "inventory:receive",
    "inventory:adjust",
    "inventory:count",
    "reports:inventory",
  ],
  CLERK: [
    "store:read",
    "catalog:read",
    "inventory:read",
    "orders:read",
    "orders:manage",
    "orders:create-pos",
    "orders:cancel",
    "payments:collect-cash",
    "payments:read",
    "customers:read",
    "customers:message",
    "delivery:assign",
  ],
  DELIVERY: ["store:read", "orders:read", "delivery:read-own", "delivery:update-own"],
};

/**
 * Guardrails (§4.4): the superset of permissions a Store Admin may GRANT to a
 * membership beyond its role default. A GRANT outside this set must be
 * rejected server-side with 422 — never silently dropped.
 */
export const ROLE_OPTIONAL_GRANT_SUPERSET: Record<MembershipRole, readonly Permission[]> = {
  STORE_ADMIN: [],
  INVENTORY_MANAGER: ["catalog:publish", "orders:read"],
  CLERK: ["orders:refund", "coupons:manage", "reports:sales"],
  DELIVERY: ["payments:collect-cash"],
};

export type PermissionOverride = { permission: Permission; effect: "GRANT" | "DENY" };

/**
 * Resolve a membership's effective permission set (§12.5).
 * Pure function — the API caches the result in Redis; this function is what
 * both the cache-miss path and any test call to verify the cache.
 */
export function resolveEffectivePermissions(
  role: MembershipRole,
  overrides: readonly PermissionOverride[],
): ReadonlySet<Permission> {
  const effective = new Set<Permission>(ROLE_DEFAULT_PERMISSIONS[role]);

  for (const o of overrides) {
    if (o.effect === "GRANT") {
      const allowed = ROLE_OPTIONAL_GRANT_SUPERSET[role].includes(o.permission);
      if (!allowed) {
        throw new Error(
          `Permission "${o.permission}" is outside the allowed grant superset for role ${role}`,
        );
      }
      effective.add(o.permission);
    }
  }
  for (const o of overrides) {
    if (o.effect === "DENY") effective.delete(o.permission);
  }

  return effective;
}

export function hasPermission(
  effective: ReadonlySet<Permission>,
  required: Permission,
): boolean {
  return effective.has(required);
}
