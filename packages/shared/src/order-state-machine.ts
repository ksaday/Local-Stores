// Order lifecycle and transition rules. See docs/plan/05-user-journeys.md §5.1
// and docs/plan/12-backend-architecture.md §12.7.
//
// Consumed by:
//   - apps/api orders.service (authoritative — enforced again by a DB trigger backstop)
//   - apps/web StatusActionBar (renders only the buttons a transition allows)
//   - apps/worker (PENDING expiry sweeper)
// One definition. The API and UI must never be able to disagree about what's legal.
import type { MembershipRole } from "./roles.js";

export const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "RETURNED",
  "REFUNDED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["PICKED_UP", "OUT_FOR_DELIVERY", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "READY"],
  PICKED_UP: ["RETURNED"],
  DELIVERED: ["RETURNED"],
  CANCELLED: ["REFUNDED"],
  RETURNED: ["REFUNDED"],
  REFUNDED: [],
};

/** Which store-scoped roles may perform a given edge. "SYSTEM" = webhook/scheduled job. */
export type TransitionActor = MembershipRole | "SYSTEM" | "CUSTOMER";

const TRANSITION_ACTORS: Record<string, readonly TransitionActor[]> = {
  "PENDING->CONFIRMED": ["SYSTEM", "CLERK", "STORE_ADMIN"],
  "PENDING->CANCELLED": ["CUSTOMER", "CLERK", "STORE_ADMIN", "SYSTEM"],
  "CONFIRMED->PREPARING": ["CLERK", "STORE_ADMIN"],
  "CONFIRMED->CANCELLED": ["CUSTOMER", "CLERK", "STORE_ADMIN"],
  "PREPARING->READY": ["CLERK", "STORE_ADMIN"],
  "PREPARING->CANCELLED": ["CLERK", "STORE_ADMIN"],
  "READY->PICKED_UP": ["CLERK", "STORE_ADMIN"],
  "READY->OUT_FOR_DELIVERY": ["DELIVERY", "SYSTEM"],
  "READY->CANCELLED": ["CLERK", "STORE_ADMIN"],
  "OUT_FOR_DELIVERY->DELIVERED": ["DELIVERY"],
  "OUT_FOR_DELIVERY->READY": ["DELIVERY", "SYSTEM"],
  "PICKED_UP->RETURNED": ["CLERK", "STORE_ADMIN"],
  "DELIVERED->RETURNED": ["CLERK", "STORE_ADMIN"],
  "CANCELLED->REFUNDED": ["SYSTEM", "STORE_ADMIN", "CLERK"],
  "RETURNED->REFUNDED": ["SYSTEM", "STORE_ADMIN", "CLERK"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isActorAllowed(
  from: OrderStatus,
  to: OrderStatus,
  actor: TransitionActor,
): boolean {
  const allowed = TRANSITION_ACTORS[`${from}->${to}`];
  return allowed !== undefined && allowed.includes(actor);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
  ) {
    super(`Cannot move an order from ${from} to ${to}.`);
    this.name = "InvalidTransitionError";
  }
}

/** Throws InvalidTransitionError if illegal. Callers still separately check isActorAllowed. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
