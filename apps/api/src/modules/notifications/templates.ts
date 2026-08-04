import type { NotificationEvent } from "./catalog.js";

export interface OrderContext {
  storeName: string;
  orderNumber: string;
  totalCents: number;
  currency: string;
  fulfillment: "PICKUP" | "DELIVERY";
  /** Only set for a cancellation, and only when somebody gave one. */
  reason?: string;
}

export interface RenderedMessage {
  subject: string;
  body: string;
}

/**
 * The words a customer actually receives.
 *
 * Plain text, and plain language: the reader is somebody who bought a loaf of
 * bread, not a user of a SaaS product. Every message says what happened and
 * what it means for them — and stops there.
 *
 * No URL in the body. These are read in the app, where the notification
 * already carries a link the reader can press; a pasted address underneath is
 * a habit from email, and it reads as one.
 *
 * Branded by naming the shop rather than by styling. A customer buying from
 * four local shops should be able to tell them apart, not see four instances
 * of the same platform.
 */
export function renderOrderMessage(
  event: NotificationEvent,
  ctx: OrderContext,
): RenderedMessage | null {
  const money = formatMoney(ctx.totalCents, ctx.currency);
  const collecting = ctx.fulfillment === "PICKUP";

  switch (event) {
    case "order.placed":
      return {
        subject: `${ctx.storeName}: order ${ctx.orderNumber} confirmed`,
        body:
          `Thanks — ${ctx.storeName} has your order.\n\n` +
          `Order ${ctx.orderNumber}, ${money}.\n` +
          (collecting
            ? `They'll let you know when it's ready to collect.\n`
            : `They'll let you know when it's on its way.\n`),
      };

    case "order.ready":
      return collecting
        ? {
            subject: `${ctx.storeName}: order ${ctx.orderNumber} is ready`,
            body:
              `Your order is ready to collect from ${ctx.storeName}.\n\n` +
              `Order ${ctx.orderNumber}, ${money}.\n`,
          }
        : {
            // A delivery order reaching READY means it is packed and waiting
            // for a driver — telling the customer "ready" would read as
            // "come and get it".
            subject: `${ctx.storeName}: order ${ctx.orderNumber} is packed`,
            body:
              `${ctx.storeName} has packed your order and it's waiting for a driver.\n\n` +
              `Order ${ctx.orderNumber}, ${money}.\n`,
          };

    case "order.out_for_delivery":
      return {
        subject: `${ctx.storeName}: order ${ctx.orderNumber} is on its way`,
        body:
          `Your order from ${ctx.storeName} is out for delivery.\n\n` +
          `Order ${ctx.orderNumber}, ${money}.\n`,
      };

    case "order.delivered":
      return {
        subject: `${ctx.storeName}: order ${ctx.orderNumber} delivered`,
        body:
          `Your order from ${ctx.storeName} has been delivered.\n\n` +
          `Order ${ctx.orderNumber}, ${money}.\n\n` +
          `If something isn't right, get in touch with the shop.\n`,
      };

    case "order.cancelled":
      return {
        subject: `${ctx.storeName}: order ${ctx.orderNumber} cancelled`,
        body:
          `${ctx.storeName} has cancelled order ${ctx.orderNumber}.\n\n` +
          (ctx.reason ? `Reason given: ${ctx.reason}\n\n` : "") +
          // Said plainly and without conditions: "any payment will be
          // refunded" is what somebody wants to read first.
          `Anything you paid is refunded to the card you used. It can take a ` +
          `few days to appear, depending on your bank.\n`,
      };

    default:
      // Low stock and billing have their own senders, which know things this
      // one does not. Returning null keeps that explicit rather than
      // inventing a message here.
      return null;
  }
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
