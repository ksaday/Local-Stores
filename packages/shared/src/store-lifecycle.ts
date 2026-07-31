// Store lifecycle. See docs/plan/02-functional-requirements.md FR-STORE-06.
//
// Shared with the frontend for the same reason as the order state machine: the
// UI must not offer a transition the API will reject.

export const STORE_STATUSES = ["APPROVED", "ACTIVE", "SUSPENDED", "CLOSED"] as const;

export type StoreStatus = (typeof STORE_STATUSES)[number];

/**
 * APPROVED is provisioned but not publicly visible — the owner is still setting
 * up, and a half-built storefront should not be reachable by customers.
 *
 * CLOSED is terminal. Reopening is a new application rather than a transition:
 * a store that closed and returns months later needs its details re-reviewed,
 * not silently reactivated with stale information.
 */
export const STORE_TRANSITIONS: Record<StoreStatus, readonly StoreStatus[]> = {
  APPROVED: ["ACTIVE", "CLOSED"],
  ACTIVE: ["SUSPENDED", "CLOSED"],
  SUSPENDED: ["ACTIVE", "CLOSED"],
  CLOSED: [],
};

/** Statuses at which the storefront is reachable by the public. */
export const PUBLICLY_VISIBLE_STATUSES: readonly StoreStatus[] = ["ACTIVE"];

/** Statuses at which staff may sign in to the store's ops surface. */
export const STAFF_ACCESSIBLE_STATUSES: readonly StoreStatus[] = ["APPROVED", "ACTIVE"];

export function canTransitionStore(from: StoreStatus, to: StoreStatus): boolean {
  return STORE_TRANSITIONS[from].includes(to);
}

export function isPubliclyVisible(status: StoreStatus): boolean {
  return PUBLICLY_VISIBLE_STATUSES.includes(status);
}

export function isStaffAccessible(status: StoreStatus): boolean {
  return STAFF_ACCESSIBLE_STATUSES.includes(status);
}

export class InvalidStoreTransitionError extends Error {
  constructor(
    readonly from: StoreStatus,
    readonly to: StoreStatus,
  ) {
    super(`Cannot move a store from ${from} to ${to}.`);
    this.name = "InvalidStoreTransitionError";
  }
}

export function assertStoreTransition(from: StoreStatus, to: StoreStatus): void {
  if (!canTransitionStore(from, to)) throw new InvalidStoreTransitionError(from, to);
}
