import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import type { Env } from "../../config/env.js";
import { Mailer } from "../../infra/mailer/mailer.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { EVENT_CATALOG, type Channel, type NotificationEvent } from "./catalog.js";
import { renderOrderMessage } from "./templates.js";

export interface InboxItem {
  id: string;
  store_id: string | null;
  store_name: string | null;
  event: string;
  title: string;
  body: string;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}

export interface Preference {
  event: string;
  channel: Channel;
  storeId: string | null;
  enabled: boolean;
}

/**
 * One place that decides whether somebody hears about something, and puts it
 * where they will see it: the app (ADR 0001).
 *
 * A notification is written into somebody's inbox, not sent anywhere. There is
 * no delivery state, no retry and no queue, because nothing leaves the
 * building — which is most of the reason for the decision. Email survives only
 * where in-app cannot reach: account access, and billing warnings aimed at an
 * owner who is not signing in.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Tells a customer something about their order.
   *
   * Takes the order id and reads the rest, rather than trusting a caller to
   * pass a total and a shop name: the caller has just changed the order, and
   * the message should describe what is true now.
   */
  async notifyOrder(event: NotificationEvent, storeId: string, orderId: string): Promise<boolean> {
    const [order] = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<
        {
          order_number: string;
          total_cents: number;
          currency: string;
          fulfillment: "PICKUP" | "DELIVERY";
          contact_email: string | null;
          customer_id: string | null;
          cancel_reason: string | null;
          store_name: string;
        }[]
      >`
        SELECT o.order_number, o.total_cents, o.currency, o.fulfillment::text AS fulfillment,
               o.contact_email, o.customer_id, s.name AS store_name,
               -- The reason lives on the status change, not the order: orders
               -- have no cancel_reason column, and the note somebody typed
               -- when cancelling is the thing worth repeating back.
               (SELECT h.note FROM order_status_history h
                WHERE h.order_id = o.id AND h.to_status = 'CANCELLED'
                ORDER BY h.created_at DESC LIMIT 1) AS cancel_reason
        FROM orders o JOIN stores s ON s.id = o.store_id
        WHERE o.id = ${orderId} AND o.store_id = ${storeId}
      `,
    );

    if (!order) return false;

    // A guest checkout has no account, so there is no inbox to write to. They
    // follow their order by its receipt link instead, which is what the claim
    // token in that link is for.
    if (!order.customer_id) return false;

    if (!(await this.wants(order.customer_id, storeId, event, "IN_APP"))) return false;

    const message = renderOrderMessage(event, {
      storeName: order.store_name,
      orderNumber: order.order_number,
      totalCents: order.total_cents,
      currency: order.currency,
      fulfillment: order.fulfillment,
      orderUrl: `${this.webOrigin()}/orders/${orderId}`,
      reason: order.cancel_reason ?? undefined,
    });
    if (!message) return false;

    await this.deliver({
      userId: order.customer_id,
      storeId,
      event,
      title: message.subject,
      body: message.body,
      link: `/orders/${orderId}`,
    });
    return true;
  }

  /**
   * Puts one notification in somebody's inbox.
   *
   * Written as the platform, because the sender is almost never the recipient:
   * a clerk marking an order ready is telling a customer, and a sweep telling
   * a shop owner has no session at all.
   */
  async deliver(input: {
    userId: string;
    storeId: string | null;
    event: NotificationEvent;
    title: string;
    body: string;
    link?: string;
  }): Promise<void> {
    await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$executeRaw`
        INSERT INTO notifications (id, user_id, store_id, event, title, body, link, created_at)
        VALUES (${randomUUID()}, ${input.userId}, ${input.storeId}, ${input.event},
                ${input.title}, ${input.body}, ${input.link ?? null}, now())
      `,
    );
    this.logger.log(`Notified ${input.userId}: ${input.event}`);
  }

  /** Somebody's inbox, newest first. */
  async inbox(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
    return this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<InboxItem[]>`
        SELECT n.id, n.store_id, s.name AS store_name, n.event, n.title, n.body,
               n.link, n.read_at, n.created_at
        FROM notifications n
        LEFT JOIN stores s ON s.id = n.store_id
        WHERE n.user_id = ${userId}
          AND (${opts.unreadOnly ?? false}::boolean = false OR n.read_at IS NULL)
        ORDER BY n.created_at DESC
        LIMIT ${Math.min(opts.limit ?? 50, 200)}
      `,
    );
  }

  /** What the badge in the shell shows. */
  async unreadCount(userId: string): Promise<number> {
    const [row] = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM notifications WHERE user_id = ${userId} AND read_at IS NULL`,
    );
    return Number(row?.count ?? 0);
  }

  /**
   * Marks one, or everything, as read.
   *
   * Only ever the caller's own — the RLS update policy says so as well, so a
   * mistake here cannot mark somebody else's inbox read.
   */
  async markRead(userId: string, notificationId?: string): Promise<number> {
    return this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        UPDATE notifications SET read_at = now()
        WHERE user_id = ${userId} AND read_at IS NULL
          AND (${notificationId ?? null}::text IS NULL OR id = ${notificationId ?? null})
      `,
    );
  }

  /**
   * Whether this person wants this, on this channel, from this shop.
   *
   * Absence of a row means yes: storing every default would mean writing one
   * per user per event at signup and migrating all of them whenever the
   * catalogue changed. A store-specific choice beats a global one, because it
   * is the more particular thing somebody said.
   *
   * A guest — no account — has no preferences and gets the transactional
   * minimum, which is everything an order sends.
   */
  async wants(
    userId: string | null,
    storeId: string,
    event: NotificationEvent,
    channel: Channel,
  ): Promise<boolean> {
    if (EVENT_CATALOG[event]?.transactional) return true;
    if (!userId) return true;

    const rows = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<{ store_id: string | null; enabled: boolean }[]>`
        SELECT store_id, enabled FROM notification_preferences
        WHERE user_id = ${userId} AND event = ${event} AND channel = ${channel}::"NotificationChannel"
          AND (store_id = ${storeId} OR store_id IS NULL)
      `,
    );
    if (rows.length === 0) return true;

    const forThisStore = rows.find((r) => r.store_id === storeId);
    return (forThisStore ?? rows[0]!).enabled;
  }

  /** Somebody's own choices, for the preferences screen. */
  async preferencesFor(userId: string): Promise<Preference[]> {
    const rows = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<{ event: string; channel: Channel; store_id: string | null; enabled: boolean }[]>`
        SELECT event, channel::text, store_id, enabled
        FROM notification_preferences WHERE user_id = ${userId}
        ORDER BY event, channel
      `,
    );
    return rows.map((r) => ({
      event: r.event,
      channel: r.channel,
      storeId: r.store_id,
      enabled: r.enabled,
    }));
  }

  /**
   * Records a choice.
   *
   * Refuses to switch off anything transactional rather than silently storing a
   * preference that will never be honoured — a switch that does nothing is
   * worse than no switch.
   */
  async setPreference(
    userId: string,
    input: { event: NotificationEvent; channel: Channel; storeId?: string | null; enabled: boolean },
  ): Promise<void> {
    const definition = EVENT_CATALOG[input.event];
    if (!definition) return;
    if (definition.transactional && !input.enabled) {
      throw new Error(`${input.event} cannot be switched off.`);
    }

    await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        INSERT INTO notification_preferences (id, user_id, store_id, event, channel, enabled, created_at, updated_at)
        VALUES (${randomUUID()}, ${userId}, ${input.storeId ?? null}, ${input.event},
                ${input.channel}::"NotificationChannel", ${input.enabled}, now(), now())
        ON CONFLICT (user_id, COALESCE(store_id, ''), event, channel)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
      `,
    );
  }

  private webOrigin(): string {
    return this.config.get("WEB_ORIGIN", { infer: true }).replace(/\/$/, "");
  }
}
