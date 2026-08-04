/**
 * What the platform will tell somebody about, and who hears it (plan §5.9).
 *
 * A catalogue in code rather than a table: adding an event is a deploy, not a
 * migration, and the templates live next to their entries so nobody can add an
 * event that nothing knows how to render.
 */
export const NOTIFICATION_EVENTS = [
  "order.placed",
  "order.ready",
  "order.out_for_delivery",
  "order.delivered",
  "order.cancelled",
  "inventory.low_stock",
  "subscription.payment_failed",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export type Channel = "EMAIL" | "IN_APP" | "PUSH" | "SMS";

export interface EventDefinition {
  /** Shown on the preferences screen. Written for the person choosing. */
  label: string;
  description: string;
  /** Which of these a person may switch off. */
  channels: Channel[];
  /**
   * Sent whatever the preferences say.
   *
   * Reserved for things that are how the account or the money works rather
   * than news somebody may not want. A shop being told its card failed is not
   * marketing; suppressing it would take the shop offline without warning.
   */
  transactional?: boolean;
}

export const EVENT_CATALOG: Record<NotificationEvent, EventDefinition> = {
  "order.placed": {
    label: "Order confirmations",
    description: "When you place an order, so you have the details in writing.",
    channels: ["EMAIL"],
  },
  "order.ready": {
    label: "Ready to collect",
    description: "When a shop has your order waiting.",
    channels: ["EMAIL"],
  },
  "order.out_for_delivery": {
    label: "Out for delivery",
    description: "When somebody sets off with your order.",
    channels: ["EMAIL"],
  },
  "order.delivered": {
    label: "Delivered",
    description: "When your order has been handed over.",
    channels: ["EMAIL"],
  },
  "order.cancelled": {
    label: "Cancellations",
    description: "If an order is cancelled, and what happens to any payment.",
    // Not optional: somebody whose order was cancelled has to be told, or they
    // are waiting for something that is never coming.
    channels: ["EMAIL"],
    transactional: true,
  },
  "inventory.low_stock": {
    label: "Low stock",
    description: "A daily list of what has run down, if you order stock.",
    channels: ["EMAIL"],
  },
  "subscription.payment_failed": {
    label: "Billing problems",
    description: "If we cannot take payment for your shop's subscription.",
    // Suppressing this hides a storefront a week later with no warning at all.
    channels: ["EMAIL"],
    transactional: true,
  },
};

export function isNotificationEvent(value: string): value is NotificationEvent {
  return (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/** The catalogue as the preferences screen wants it. */
export function catalogForDisplay() {
  return NOTIFICATION_EVENTS.map((event) => ({
    event,
    ...EVENT_CATALOG[event],
    // A person cannot switch these off, and the screen should say so rather
    // than offer a control that does nothing.
    optional: !EVENT_CATALOG[event].transactional,
  }));
}
