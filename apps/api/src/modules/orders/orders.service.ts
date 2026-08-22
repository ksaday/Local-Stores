import { Injectable, Logger } from "@nestjs/common";
import { paymentOutcomes, paymentsUnreconciled, UNRECONCILED } from "../../infra/observability/payment-metrics.js";
import { randomUUID } from "node:crypto";
import {
  InvalidTransitionError,
  assertTransition,
  isActorAllowed,
  type OrderStatus,
  type TransitionActor,
} from "@bba/shared";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import type { NotificationEvent } from "../notifications/catalog.js";

export interface OrderListFilters {
  status?: OrderStatus;
  /** Everything still needing someone's attention — the clerk's default view. */
  openOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * An order still being worked on: placed, and not yet finished or abandoned.
 *
 * One list, used by both the queue filter and the pipeline count, so the two
 * can never disagree about what "open" means.
 */
const OPEN_STATUSES: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
];

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Which status changes the customer hears about (plan §5.9).
   *
   * Not every one: PREPARING and CONFIRMED are the shop's business, and a
   * customer emailed at every internal step stops reading any of them.
   */
  private static readonly CUSTOMER_TOLD_ABOUT: Partial<Record<OrderStatus, NotificationEvent>> = {
    READY: "order.ready",
    OUT_FOR_DELIVERY: "order.out_for_delivery",
    DELIVERED: "order.delivered",
    CANCELLED: "order.cancelled",
  };

  /**
   * How many orders sit at each open status, for the owner's morning view.
   *
   * Counted live rather than from a rollup, because it touches only orders
   * that are still open — a working queue rather than a history. In practice
   * that is dozens: PENDING expires on its own and everything else gets worked
   * through, so the set does not grow with the shop's age the way ADR 0003's
   * queries do.
   *
   * Measured at ~310ms against a fixture holding 333,000 open orders, which is
   * a state a real shop cannot reach without years of neglect. A normal queue
   * is immeasurable. Worth knowing rather than assuming, since this is the one
   * dashboard panel that reads the transactional table.
   *
   * Statuses with nothing in them are returned as zero rather than omitted:
   * "nothing waiting to be packed" is the answer somebody is looking for, and
   * a missing key reads as a bug.
   */
  async pipeline(storeId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.order.groupBy({
        by: ["status"],
        where: { storeId, status: { in: OPEN_STATUSES } },
        _count: { _all: true },
      }),
    );

    const counts = Object.fromEntries(OPEN_STATUSES.map((s) => [s, 0]));
    for (const row of rows) counts[row.status] = row._count._all;
    return counts;
  }

  /** The store's order queue. */
  async listForStore(storeId: string, filters: OrderListFilters = {}) {
    const limit = Math.min(filters.limit ?? 50, 200);

    const where = {
      storeId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.openOnly ? { status: { in: OPEN_STATUSES } } : {}),
    };

    const [orders, total] = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => [
      await tx.order.findMany({
        where,
        orderBy: { placedAt: "desc" },
        take: limit,
        skip: Math.max(filters.offset ?? 0, 0),
        select: {
          id: true, orderNumber: true, status: true, fulfillment: true, channel: true,
          totalCents: true, currency: true, placedAt: true, customerNote: true,
          contactEmail: true, contactPhone: true,
          customer: { select: { id: true, name: true, email: true } },
          items: { select: { productName: true, qty: true } },
        },
      }),
      await tx.order.count({ where }),
    ]);

    return { orders, total };
  }

  /** One order in full, for the store's workbench. */
  async getForStore(storeId: string, orderId: string) {
    const order = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.order.findFirst({
        where: { id: orderId, storeId },
        include: {
          items: true,
          history: { orderBy: { createdAt: "asc" } },
          payments: true,
          customer: { select: { id: true, name: true, email: true, phone: true } },
          // The receipt needs the shop's own name and address on it.
          store: {
            select: {
              name: true, addressLine1: true, city: true, state: true, postalCode: true,
            },
          },
        },
      }),
    );
    if (!order) throw AppError.notFound();
    return order;
  }

  /** A customer's own orders, across every store they've bought from. */
  async listForCustomer(userId: string, limit = 50) {
    return this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.order.findMany({
        where: { customerId: userId },
        orderBy: { placedAt: "desc" },
        take: Math.min(limit, 100),
        select: {
          id: true, orderNumber: true, status: true, fulfillment: true,
          totalCents: true, currency: true, placedAt: true,
          store: { select: { slug: true, name: true } },
          items: { select: { productName: true, qty: true } },
        },
      }),
    );
  }

  /**
   * One of the customer's own orders.
   *
   * A guest passes the claim token from their receipt instead of signing in.
   * The token is matched by RLS, not by a WHERE clause here, so a wrong token
   * yields no row rather than someone else's order.
   */
  async getForCustomer(orderId: string, identity: { userId?: string; guestToken?: string }) {
    const order = await this.prisma.withTenant(
      { userId: identity.userId, guestToken: identity.guestToken, isSuperAdmin: false },
      (tx) =>
        tx.order.findFirst({
          where: { id: orderId },
          include: {
            items: true,
            history: { orderBy: { createdAt: "asc" }, select: { toStatus: true, createdAt: true, note: true } },
            // Enough for the receipt to offer payment: whether this shop takes
            // cards at all, and its palette so the card form matches.
            store: {
              select: {
                id: true, slug: true, name: true, addressLine1: true, city: true, state: true,
                cashEnabled: true, stripeChargesEnabled: true, branding: true,
              },
            },
            // Status only — no provider ids or intent secrets on a page a
            // guest can open with a link.
            payments: { select: { provider: true, status: true, amountCents: true } },
          },
        }),
    );
    if (!order) throw AppError.notFound();
    return order;
  }

  /**
   * Moves an order to a new status.
   *
   * Three separate checks, none of which is redundant: the transition must be
   * legal at all, this actor's role must be allowed to perform that specific
   * edge, and the database trigger backstops both. A delivery driver may mark
   * DELIVERED but must not be able to cancel and refund.
   */
  async transition(
    storeId: string,
    orderId: string,
    to: OrderStatus,
    // A null userId means the system did it — the expiry sweeper has no
    // person behind it, and `actor_user_id` is nullable for exactly that.
    actor: { userId: string | null; role: TransitionActor },
    note?: string,
  ) {
    const result = await this.prisma.withTenant(
      { storeId, userId: actor.userId ?? undefined, isSuperAdmin: false },
      async (tx) => {
        // Locked for the duration: two clerks tapping "Ready" at once would
        // otherwise both read PREPARING and both write history rows.
        const [current] = await tx.$queryRaw<{ status: OrderStatus; orderNumber: string }[]>`
          SELECT status, order_number AS "orderNumber" FROM orders
          WHERE id = ${orderId} AND store_id = ${storeId} FOR UPDATE
        `;
        if (!current) throw AppError.notFound();

        const from = current.status;
        if (from === to) {
          return { id: orderId, status: to, unchanged: true, orderNumber: current.orderNumber };
        }

        try {
          assertTransition(from, to);
        } catch (err) {
          if (err instanceof InvalidTransitionError) {
            throw AppError.validation(
              `This order is ${humanize(from)} — it can't be marked ${humanize(to)}.`,
            );
          }
          throw err;
        }

        if (!isActorAllowed(from, to, actor.role)) {
          throw AppError.forbidden(`Your role can't move an order from ${humanize(from)} to ${humanize(to)}.`);
        }

        await this.applyStockEffects(tx, storeId, orderId, from, to, actor.userId);

        await tx.$executeRaw`
          UPDATE orders SET status = ${to}::"OrderStatus", updated_at = now(),
            expires_at = CASE WHEN ${to}::"OrderStatus" = 'PENDING' THEN expires_at ELSE NULL END
          WHERE id = ${orderId}
        `;

        await tx.$executeRaw`
          INSERT INTO order_status_history (id, order_id, store_id, from_status, to_status, actor_user_id, note)
          VALUES (${randomUUID()}, ${orderId}, ${storeId}, ${from}::"OrderStatus", ${to}::"OrderStatus",
                  ${actor.userId}, ${note ?? null})
        `;

        // Inside the transaction: the status change and the notice of it
        // commit together or not at all.
        await this.outbox.emitIn(tx, {
          type: "order.status_changed",
          storeId,
          aggregateId: orderId,
          payload: { orderId, orderNumber: current.orderNumber, status: to, from },
        });

        this.logger.log(`Order ${orderId}: ${from} -> ${to} by ${actor.userId}`);
        return { id: orderId, status: to, unchanged: false, orderNumber: current.orderNumber };
      },
    );

    // After the transaction, and deliberately not inside it: the customer's
    // email is not worth rolling a status change back for, and a mail provider
    // has no business holding a database transaction open. It is queued
    // anyway, so this is a Redis write rather than an SMTP conversation.
    if (!result.unchanged) {
      const event = OrdersService.CUSTOMER_TOLD_ABOUT[to];
      if (event) {
        await this.notifications
          .notifyOrder(event, storeId, orderId)
          .catch((err: unknown) =>
            // A failure here must not undo a status the shop has already acted
            // on — the parcel is out for delivery whether or not the email got
            // queued.
            this.logger.error(`Could not notify for ${orderId}: ${String(err)}`),
          );
      }
    }

    return result;
  }

  /**
   * Keeps stock honest as an order moves.
   *
   * Reservations are held from placement. Confirming turns the reservation
   * into an actual decrement via the ledger; cancelling releases it. Getting
   * this wrong in either direction is how a shop ends up either overselling or
   * with phantom stock it cannot sell.
   */
  private async applyStockEffects(
    tx: { $queryRaw: PrismaService["$queryRaw"]; $executeRaw: PrismaService["$executeRaw"] },
    storeId: string,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    actorUserId: string | null,
  ): Promise<void> {
    const holdsReservation = from === "PENDING";
    const items = await tx.$queryRaw<{ variant_id: string | null; qty: number }[]>`
      SELECT variant_id, qty FROM order_items WHERE order_id = ${orderId}
    `;

    if (to === "CONFIRMED" && holdsReservation) {
      for (const item of items) {
        if (!item.variant_id) continue;
        const [level] = await tx.$queryRaw<{ tracked: boolean }[]>`
          SELECT tracked FROM stock_levels WHERE variant_id = ${item.variant_id} FOR UPDATE
        `;
        if (!level?.tracked) continue;

        // Release the hold and record the sale. The ledger trigger applies the
        // decrement to on_hand — application code never writes it directly.
        await tx.$executeRaw`
          UPDATE stock_levels SET reserved = reserved - ${item.qty}, updated_at = now()
          WHERE variant_id = ${item.variant_id}
        `;
        await tx.$executeRaw`
          INSERT INTO stock_movements (id, store_id, variant_id, type, qty_delta, order_id, actor_user_id)
          VALUES (${randomUUID()}, ${storeId}, ${item.variant_id}, 'SALE', ${-item.qty}, ${orderId}, ${actorUserId})
        `;
      }
      return;
    }

    if (to === "CANCELLED" && holdsReservation) {
      // Never sold, so nothing to put back on the shelf — just drop the hold.
      for (const item of items) {
        if (!item.variant_id) continue;
        await tx.$executeRaw`
          UPDATE stock_levels SET reserved = GREATEST(reserved - ${item.qty}, 0), updated_at = now()
          WHERE variant_id = ${item.variant_id} AND tracked = true
        `;
      }
      return;
    }

    if (to === "CANCELLED" || to === "RETURNED") {
      // Past CONFIRMED the stock was decremented, so coming back means it
      // physically returns to the shelf.
      for (const item of items) {
        if (!item.variant_id) continue;
        const [level] = await tx.$queryRaw<{ tracked: boolean }[]>`
          SELECT tracked FROM stock_levels WHERE variant_id = ${item.variant_id} FOR UPDATE
        `;
        if (!level?.tracked) continue;

        await tx.$executeRaw`
          INSERT INTO stock_movements (id, store_id, variant_id, type, qty_delta, order_id, actor_user_id, reason_code)
          VALUES (${randomUUID()}, ${storeId}, ${item.variant_id}, 'RETURN', ${item.qty}, ${orderId},
                  ${actorUserId}, ${to === "RETURNED" ? "customer_return" : "cancelled_after_confirm"})
        `;
      }
    }
  }

  /**
   * Records a cash payment as collected.
   *
   * Separate from the status transition on purpose: money changing hands and
   * an order being confirmed are different facts, and a clerk who taps the
   * wrong one should not silently create the other.
   */
  async recordCashPayment(storeId: string, orderId: string, actorUserId: string) {
    const result = await this.prisma.withTenant({ storeId, userId: actorUserId, isSuperAdmin: false }, async (tx) => {
      const [payment] = await tx.$queryRaw<
        { id: string; status: string; amount_cents: number; order_number: string }[]
      >`
        SELECT p.id, p.status::text AS status, p.amount_cents, o.order_number
        FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.order_id = ${orderId} AND p.store_id = ${storeId} AND p.provider = 'CASH'
        FOR UPDATE OF p
      `;
      if (!payment) throw AppError.notFound("No cash payment is outstanding for this order.");
      if (payment.status === "SUCCEEDED") {
        // Already collected. Returning the existing state rather than erroring
        // means a double-tap on a busy counter is harmless.
        return {
          paymentId: payment.id,
          amountCents: payment.amount_cents,
          alreadyRecorded: true,
          orderNumber: payment.order_number,
        };
      }

      await tx.$executeRaw`
        UPDATE payments
        SET status = 'SUCCEEDED', cash_received_by = ${actorUserId}, cash_received_at = now(), updated_at = now()
        WHERE id = ${payment.id}
      `;

      // Counted here rather than on the double-tap path above: an
      // already-collected payment returns early, and counting it again would
      // report takings a clerk never took.
      paymentOutcomes.inc({ provider: "CASH", outcome: "succeeded", reason: "none" });

      await this.audit.record({
        storeId,
        actorUserId,
        action: "payment.cash_collected",
        entityType: "payment",
        entityId: payment.id,
        after: { orderId, amountCents: payment.amount_cents },
      });

      await this.retireSupersededPayments(tx, storeId, orderId);

      await this.outbox.emitIn(tx, {
        type: "order.payment_recorded",
        storeId,
        aggregateId: orderId,
        payload: { orderId, orderNumber: payment.order_number, amountCents: payment.amount_cents },
      });

      return {
        paymentId: payment.id,
        amountCents: payment.amount_cents,
        alreadyRecorded: false,
        orderNumber: payment.order_number,
      };
    });

    return result;
  }

  /**
   * Retires every other payment attempt once one of them succeeds.
   *
   * An order carries a CASH row from the moment it is placed, because most
   * orders in the pilot are paid in cash. When a card payment then succeeds,
   * that CASH row is stale — and the workbench reads it as money still owed,
   * so a clerk is shown "Take $17.64 cash" for an order the customer has
   * already been charged for. They pay twice.
   *
   * Symmetric on purpose: taking cash also retires an abandoned card intent,
   * so a customer who gives up on the card form and pays at the counter does
   * not leave a live intent behind them.
   */
  async retireSupersededPayments(
    tx: { $executeRaw: PrismaService["$executeRaw"] },
    storeId: string,
    orderId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE payments
      SET status = 'CANCELED', updated_at = now()
      WHERE order_id = ${orderId} AND store_id = ${storeId} AND status <> 'SUCCEEDED'
    `;
  }

  /**
   * Releases stock held by PENDING orders that were never completed.
   *
   * Without this, an abandoned checkout holds the last item off the shelf
   * forever. Runs from a scheduled job; safe to call repeatedly.
   */
  async expireStaleOrders(now = new Date()): Promise<number> {
    // Deliberately super-admin scope, not `unscoped()`. The sweep is
    // cross-tenant by nature — it has no store and no user — and `unscoped()`
    // runs with *empty* RLS context, which matches zero orders and silently
    // sweeps nothing. That failure is invisible: the job succeeds, reports 0,
    // and stock stays held forever.
    const stale = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ id: string; store_id: string; paid: boolean }[]>`
        SELECT o.id, o.store_id,
               -- Asked here rather than in a second round trip per order. This
               -- sweep cancels PENDING orders and releases their stock without
               -- regard to payment, so an order that was paid but never
               -- confirmed is cancelled with the note "Expired without
               -- payment" — which is false, and takes the customer's money
               -- with it. Detecting it is what this column is for.
               EXISTS (
                 SELECT 1 FROM payments p
                 WHERE p.order_id = o.id AND p.status = 'SUCCEEDED'
               ) AS paid
        FROM orders o
        WHERE o.status = 'PENDING' AND o.expires_at IS NOT NULL AND o.expires_at < ${now}
        LIMIT 200
      `,
    );

    let expired = 0;
    for (const order of stale) {
      try {
        // SYSTEM is a legitimate actor for PENDING->CANCELLED; the same
        // transition path applies, so the reservation release is not a
        // second implementation that could drift.
        await this.transition(
          order.store_id,
          order.id,
          "CANCELLED",
          { userId: null, role: "SYSTEM" },
          "Expired without payment",
        );
        expired += 1;

        // Counted after the cancellation succeeded, because that is the moment
        // the money became unaccounted for. Deliberately not *prevented* here:
        // refusing to expire a paid order would hold its stock indefinitely,
        // which is a product decision rather than a fix to make in passing.
        if (order.paid) {
          paymentsUnreconciled.inc({ cause: UNRECONCILED.EXPIRED_WHILE_PAID });
          this.logger.error(
            `Expired order ${order.id} had a successful payment. The customer has been charged for a cancelled order.`,
          );
        }
      } catch (err) {
        // One bad order must not stop the sweep.
        this.logger.warn(`Could not expire order ${order.id}: ${String(err)}`);
      }
    }
    return expired;
  }
}

function humanize(status: OrderStatus): string {
  return status.toLowerCase().replace(/_/g, " ");
}
