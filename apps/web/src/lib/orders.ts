import "server-only";
import {
  ORDER_TRANSITIONS,
  isActorAllowed,
  type MembershipRole,
  type OrderStatus,
  type TransitionActor,
} from "@bba/shared";
import { api } from "./api";

export interface StoreOrderSummary {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  fulfillment: "PICKUP" | "DELIVERY";
  channel: "ONLINE" | "POS";
  totalCents: number;
  currency: string;
  placedAt: string;
  customerNote: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  customer: { id: string; name: string; email: string } | null;
  items: { productName: string; qty: number }[];
}

export interface StoreOrderDetail extends Omit<StoreOrderSummary, "items"> {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  tipCents: number;
  deliveryAddress: { line1: string; line2?: string | null; city: string; state: string; postalCode: string } | null;
  items: {
    id: string;
    productName: string;
    variantAttrs: Record<string, string>;
    sku: string | null;
    qty: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }[];
  history: {
    id: string;
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    actorUserId: string | null;
    note: string | null;
    createdAt: string;
  }[];
  store: {
    name: string;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
  payments: {
    id: string;
    provider: "STRIPE" | "CASH";
    status: string;
    amountCents: number;
    cashReceivedBy: string | null;
    cashReceivedAt: string | null;
  }[];
}

/**
 * The store's order queue.
 *
 * Never cached: a clerk looking at a stale queue works the wrong order, and
 * the whole point of this screen is that it reflects the counter right now.
 */
export async function listStoreOrders(
  storeId: string,
  params: { open?: boolean; status?: string } = {},
): Promise<{ orders: StoreOrderSummary[]; total: number }> {
  const query = new URLSearchParams();
  if (params.open) query.set("open", "true");
  if (params.status) query.set("status", params.status);

  return api(`/stores/${storeId}/orders?${query}`, { revalidate: false });
}

export async function getStoreOrder(storeId: string, orderId: string): Promise<StoreOrderDetail> {
  return api(`/stores/${storeId}/orders/${orderId}`, { revalidate: false });
}

/**
 * The transitions this person may perform on this order, right now.
 *
 * Derived from the same state machine the API enforces, so the UI cannot offer
 * a button the server will refuse. Showing an action that then errors teaches
 * staff to distrust the screen.
 */
export function allowedTransitions(
  status: OrderStatus,
  role: TransitionActor,
): { to: OrderStatus; label: string; tone: "primary" | "neutral" | "danger" }[] {
  return ORDER_TRANSITIONS[status]
    .filter((to) => isActorAllowed(status, to, role))
    .map((to) => ({ to, label: ACTION_LABELS[to] ?? to, tone: TONES[to] ?? "neutral" }));
}

/** Verbs, not state names: a clerk taps "Start preparing", not "PREPARING". */
const ACTION_LABELS: Partial<Record<OrderStatus, string>> = {
  CONFIRMED: "Accept order",
  PREPARING: "Start preparing",
  READY: "Mark ready",
  PICKED_UP: "Collected",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancel",
  RETURNED: "Returned",
  REFUNDED: "Refund",
};

const TONES: Partial<Record<OrderStatus, "primary" | "neutral" | "danger">> = {
  CONFIRMED: "primary",
  PREPARING: "primary",
  READY: "primary",
  PICKED_UP: "primary",
  OUT_FOR_DELIVERY: "primary",
  DELIVERED: "primary",
  CANCELLED: "danger",
  RETURNED: "danger",
  REFUNDED: "danger",
};

export const STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: "New",
  CONFIRMED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready",
  PICKED_UP: "Collected",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
  REFUNDED: "Refunded",
};

/** The caller's role in this store, or null if they have no membership. */
export function roleInStore(
  user: { platformRole: string | null; memberships: { storeId: string; role: string }[] },
  storeId: string,
): TransitionActor | null {
  const membership = user.memberships.find((m) => m.storeId === storeId);
  if (membership) return membership.role as MembershipRole;
  // Platform staff acting on a store have no membership row. Treated as the
  // widest staff role for transitions — not as a bypass of the state machine.
  if (user.platformRole === "SUPER_ADMIN") return "STORE_ADMIN";
  return null;
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
