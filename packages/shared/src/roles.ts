// Store-scoped membership roles. See docs/plan/04-roles-permissions.md §4.1.
// SUPER_ADMIN is a platform-wide flag on the user, not a membership — it has no storeId.
export const MEMBERSHIP_ROLES = [
  "STORE_ADMIN",
  "INVENTORY_MANAGER",
  "CLERK",
  "DELIVERY",
] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export type PlatformRole = "SUPER_ADMIN" | null;
