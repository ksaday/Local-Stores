import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { OrdersService } from "../orders/orders.service.js";

export const FAILURE_REASONS = [
  "NOBODY_HOME",
  "ADDRESS_NOT_FOUND",
  "REFUSED",
  "UNSAFE_TO_LEAVE",
  "VEHICLE_PROBLEM",
  "OTHER",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface DeliveryRow {
  id: string;
  order_id: string;
  order_number: string;
  order_status: string;
  /** What a driver needs when nobody answers the door. */
  contact_phone: string | null;
  contact_email: string | null;
  delivery_address: unknown;
  driver_user_id: string | null;
  driver_name: string | null;
  assigned_at: Date | null;
  picked_up_at: Date | null;
  delivered_at: Date | null;
  failure_reason: string | null;
  failure_note: string | null;
  attempts: number;
  notes: string | null;
}

/**
 * Deliveries (plan Phase 9).
 *
 * The order's own status is the single answer to "where is this" — READY,
 * OUT_FOR_DELIVERY, DELIVERED — and every move through it goes via
 * `OrdersService`, so the state machine and its role gates are enforced in one
 * place. This service owns what the order has no business carrying: who is
 * taking it, what proof they left, and why it came back if it did.
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The dispatcher's board: every delivery order not yet handed over.
   *
   * Created lazily — an order becomes a delivery record the first time somebody
   * looks at it or assigns it, rather than at checkout. Checkout should not be
   * writing rows for a workflow that may never start.
   */
  async board(storeId: string): Promise<DeliveryRow[]> {
    await this.ensureRecords(storeId);
    return this.read(storeId, { outstandingOnly: true });
  }

  /** One driver's round. Delivered ones drop off it. */
  async queueFor(storeId: string, driverUserId: string): Promise<DeliveryRow[]> {
    await this.ensureRecords(storeId);
    return this.read(storeId, { driverUserId, outstandingOnly: true });
  }

  async assign(
    storeId: string,
    orderId: string,
    actorUserId: string,
    driverUserId: string,
  ): Promise<DeliveryRow> {
    await this.ensureRecords(storeId);
    await this.assertDriver(storeId, driverUserId);

    const updated = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        UPDATE deliveries
        SET driver_user_id = ${driverUserId}, assigned_at = now(),
            assigned_by = ${actorUserId}, updated_at = now()
        WHERE order_id = ${orderId} AND store_id = ${storeId} AND delivered_at IS NULL
      `,
    );
    if (updated === 0) {
      throw AppError.validation("That order is not out for delivery, or is already delivered.");
    }

    await this.audit.record({
      storeId,
      actorUserId,
      action: "delivery.assigned",
      entityType: "order",
      entityId: orderId,
      after: { driverUserId },
    });

    return this.one(storeId, orderId);
  }

  /** Takes a driver off a round without touching the order's status. */
  async unassign(storeId: string, orderId: string, actorUserId: string): Promise<DeliveryRow> {
    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        UPDATE deliveries
        SET driver_user_id = NULL, assigned_at = NULL, assigned_by = NULL, updated_at = now()
        WHERE order_id = ${orderId} AND store_id = ${storeId} AND delivered_at IS NULL
      `,
    );

    await this.audit.record({
      storeId,
      actorUserId,
      action: "delivery.unassigned",
      entityType: "order",
      entityId: orderId,
    });

    return this.one(storeId, orderId);
  }

  /**
   * The driver has the parcel and is on the road.
   *
   * Moves the order through the real state machine rather than writing a
   * status here, so a transition the machine forbids is forbidden here too.
   */
  async pickUp(storeId: string, orderId: string, actorUserId: string): Promise<DeliveryRow> {
    await this.assertAssignedTo(storeId, orderId, actorUserId);
    await this.orders.transition(storeId, orderId, "OUT_FOR_DELIVERY", {
      userId: actorUserId,
      role: "DELIVERY",
    });

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        UPDATE deliveries SET picked_up_at = now(), updated_at = now()
        WHERE order_id = ${orderId} AND store_id = ${storeId}
      `,
    );

    return this.one(storeId, orderId);
  }

  /**
   * Handed over.
   *
   * Proof is optional in the data but not in practice: a shop that wants
   * photographs can require them in the driver app, and a shop delivering
   * bread to a regular should not be blocked because nobody took a picture.
   */
  async complete(
    storeId: string,
    orderId: string,
    actorUserId: string,
    input: { proofMediaAssetId?: string; signatureMediaAssetId?: string; notes?: string } = {},
  ): Promise<DeliveryRow> {
    await this.assertAssignedTo(storeId, orderId, actorUserId);
    await this.orders.transition(storeId, orderId, "DELIVERED", {
      userId: actorUserId,
      role: "DELIVERY",
    });

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        UPDATE deliveries
        SET delivered_at = now(),
            proof_media_asset_id = COALESCE(${input.proofMediaAssetId ?? null}, proof_media_asset_id),
            signature_media_asset_id = COALESCE(${input.signatureMediaAssetId ?? null}, signature_media_asset_id),
            notes = COALESCE(${input.notes ?? null}, notes),
            -- Cleared: a delivery that succeeded on the second attempt is not a
            -- failed delivery, and leaving the reason behind would read as one.
            failure_reason = NULL, failure_note = NULL, failed_at = NULL,
            updated_at = now()
        WHERE order_id = ${orderId} AND store_id = ${storeId}
      `,
    );

    await this.audit.record({
      storeId,
      actorUserId,
      action: "delivery.completed",
      entityType: "order",
      entityId: orderId,
      after: { hasProof: Boolean(input.proofMediaAssetId || input.signatureMediaAssetId) },
    });

    return this.one(storeId, orderId);
  }

  /**
   * Came back with it.
   *
   * The order returns to READY, which is the state machine's own answer for a
   * delivery that did not happen: it is prepared, it is in the shop, and
   * somebody will take it out again. The reason and the attempt count stay on
   * the delivery, so a third failure is visible as a pattern rather than as
   * three unrelated events.
   */
  async fail(
    storeId: string,
    orderId: string,
    actorUserId: string,
    input: { reason: FailureReason; note?: string },
  ): Promise<DeliveryRow> {
    if (!FAILURE_REASONS.includes(input.reason)) {
      throw AppError.validation("Choose a reason the delivery didn't happen.");
    }
    await this.assertAssignedTo(storeId, orderId, actorUserId);
    await this.orders.transition(storeId, orderId, "READY", {
      userId: actorUserId,
      role: "DELIVERY",
    });

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        UPDATE deliveries
        SET failure_reason = ${input.reason}::"DeliveryFailureReason",
            failure_note = ${input.note ?? null},
            failed_at = now(),
            attempts = attempts + 1,
            picked_up_at = NULL,
            updated_at = now()
        WHERE order_id = ${orderId} AND store_id = ${storeId}
      `,
    );

    await this.audit.record({
      storeId,
      actorUserId,
      action: "delivery.failed",
      entityType: "order",
      entityId: orderId,
      severity: "MEDIUM",
      after: { reason: input.reason, note: input.note },
    });

    this.logger.warn(`Delivery for order ${orderId} failed: ${input.reason}`);
    return this.one(storeId, orderId);
  }

  async one(storeId: string, orderId: string): Promise<DeliveryRow> {
    const [row] = await this.read(storeId, { orderId });
    if (!row) throw AppError.notFound();
    return row;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Gives every delivery order a record, once it is worth having one.
   *
   * Lazy rather than created at checkout: most of an order's life has nothing
   * to do with delivery, and a row written at checkout would exist for every
   * order that is later cancelled before anyone touches it.
   */
  private async ensureRecords(storeId: string): Promise<void> {
    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        INSERT INTO deliveries (id, store_id, order_id, created_at, updated_at)
        SELECT gen_random_uuid(), o.store_id, o.id, now(), now()
        FROM orders o
        LEFT JOIN deliveries d ON d.order_id = o.id
        WHERE o.store_id = ${storeId}
          AND o.fulfillment = 'DELIVERY'
          AND o.status IN ('READY', 'OUT_FOR_DELIVERY', 'DELIVERED')
          AND d.id IS NULL
      `,
    );
  }

  private async read(
    storeId: string,
    filters: { orderId?: string; driverUserId?: string; outstandingOnly?: boolean },
  ): Promise<DeliveryRow[]> {
    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<(DeliveryRow & { driver_name: null })[]>`
        SELECT d.id, d.order_id, o.order_number, o.status::text AS order_status,
               o.contact_phone, o.contact_email, o.delivery_address,
               d.driver_user_id, NULL::text AS driver_name,
               d.assigned_at, d.picked_up_at, d.delivered_at,
               d.failure_reason::text, d.failure_note, d.attempts, d.notes
        FROM deliveries d
        JOIN orders o ON o.id = d.order_id
        WHERE d.store_id = ${storeId}
          AND (${filters.orderId ?? null}::text IS NULL OR d.order_id = ${filters.orderId ?? null})
          AND (${filters.driverUserId ?? null}::text IS NULL
               OR d.driver_user_id = ${filters.driverUserId ?? null})
          AND (${filters.outstandingOnly ?? false}::boolean = false OR d.delivered_at IS NULL)
        -- Oldest first: the parcel that has been waiting longest goes out next.
        ORDER BY o.placed_at
        LIMIT 200
      `,
    );

    // Driver names resolved as the platform: the users policy exposes only
    // members of the current store, and a driver has no membership row until
    // they accept their invitation — the same trap as everywhere else.
    const ids = [...new Set(rows.map((r) => r.driver_user_id).filter(Boolean))] as string[];
    if (ids.length === 0) return rows;

    const drivers = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id, name FROM users WHERE id = ANY(${ids})`,
    );
    const names = new Map(drivers.map((d) => [d.id, d.name]));

    return rows.map((row) => ({
      ...row,
      driver_name: row.driver_user_id ? (names.get(row.driver_user_id) ?? null) : null,
    }));
  }

  /** Only somebody who can actually drive for this shop. */
  private async assertDriver(storeId: string, driverUserId: string): Promise<void> {
    const [row] = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM store_memberships
        WHERE store_id = ${storeId} AND user_id = ${driverUserId}
          AND status = 'ACTIVE' AND role IN ('DELIVERY', 'STORE_ADMIN')
      `,
    );
    if (!row) {
      throw AppError.validation("That person isn't set up to make deliveries for this shop.");
    }
  }

  /**
   * A driver may only move their own parcels.
   *
   * `delivery:update-own` is the permission, and this is the "own" half of it —
   * the guard cannot know which delivery a request is about. A store admin is
   * exempt, because somebody has to be able to close out a round when a driver
   * has gone home with the app still open.
   */
  private async assertAssignedTo(
    storeId: string,
    orderId: string,
    actorUserId: string,
  ): Promise<void> {
    const [row] = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<{ driver_user_id: string | null; role: string | null }[]>`
        SELECT d.driver_user_id, m.role::text
        FROM deliveries d
        LEFT JOIN store_memberships m
          ON m.store_id = d.store_id AND m.user_id = ${actorUserId} AND m.status = 'ACTIVE'
        WHERE d.order_id = ${orderId} AND d.store_id = ${storeId}
      `,
    );
    if (!row) throw AppError.notFound();
    if (row.driver_user_id === actorUserId) return;
    if (row.role === "STORE_ADMIN") return;

    throw AppError.forbidden("That delivery is assigned to somebody else.");
  }
}
