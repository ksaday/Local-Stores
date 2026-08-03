import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";

/**
 * Why stock moved, beyond the movement type.
 *
 * A fixed list rather than free text: "why is our shrinkage 4%?" is answerable
 * from a column and not from reading a thousand notes. `note` is still there
 * for the detail that does not fit.
 */
export const ADJUSTMENT_REASONS = [
  "MISCOUNT",
  "DAMAGE",
  "THEFT",
  "EXPIRED",
  "SUPPLIER_SHORTAGE",
  "RETURN_TO_SUPPLIER",
  "OTHER",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export interface StockRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  /** e.g. `{ "size": "Large" }`. Empty for a single-variant product. */
  attrs: Record<string, string>;
  sku: string | null;
  on_hand: number;
  reserved: number;
  available: number;
  reorder_point: number | null;
  reorder_qty: number | null;
  tracked: boolean;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Everything sellable, with what is on the shelf and what is spoken for.
   *
   * A LEFT JOIN, so a variant that has never had a stock row still appears —
   * as zero. A product missing from this list because nobody has counted it
   * yet is exactly how stock goes untracked.
   */
  async list(
    storeId: string,
    filters: { lowStockOnly?: boolean; q?: string } = {},
  ): Promise<StockRow[]> {
    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<StockRow[]>`
        SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name,
               v.attrs, v.sku,
               COALESCE(sl.on_hand, 0) AS on_hand,
               COALESCE(sl.reserved, 0) AS reserved,
               COALESCE(sl.on_hand, 0) - COALESCE(sl.reserved, 0) AS available,
               sl.reorder_point, sl.reorder_qty,
               COALESCE(sl.tracked, false) AS tracked
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        LEFT JOIN stock_levels sl ON sl.variant_id = v.id
        WHERE v.store_id = ${storeId} AND v.deleted_at IS NULL AND p.deleted_at IS NULL
          AND (${filters.q ?? null}::text IS NULL
               OR p.name ILIKE '%' || ${filters.q ?? null} || '%'
               OR v.sku ILIKE '%' || ${filters.q ?? null} || '%')
          AND (${filters.lowStockOnly ?? false}::boolean = false OR (
            sl.tracked = true AND sl.reorder_point IS NOT NULL
            AND COALESCE(sl.on_hand, 0) - COALESCE(sl.reserved, 0) <= sl.reorder_point
          ))
        ORDER BY p.name, v.sku NULLS FIRST
        LIMIT 500
      `,
    );
  }

  /** What is at or below its reorder point. Drives both the screen and the alert. */
  async lowStock(storeId: string): Promise<StockRow[]> {
    return this.list(storeId, { lowStockOnly: true });
  }

  /**
   * Stock arriving from a supplier.
   *
   * Only ever positive. "Receiving" a negative quantity to fix a mistake would
   * put a correction in the same bucket as a delivery, and the first question
   * anyone asks of this ledger is how much actually arrived.
   */
  async receive(
    storeId: string,
    actorUserId: string,
    input: { variantId: string; qty: number; note?: string },
  ): Promise<StockRow> {
    if (!Number.isInteger(input.qty) || input.qty <= 0) {
      throw AppError.validation("Receive a whole number greater than zero.");
    }
    await this.assertVariant(storeId, input.variantId);

    await this.writeMovement(storeId, {
      variantId: input.variantId,
      type: "RECEIVE",
      qtyDelta: input.qty,
      note: input.note,
      actorUserId,
    });

    await this.audit.record({
      storeId,
      actorUserId,
      action: "inventory.received",
      entityType: "product_variant",
      entityId: input.variantId,
      after: { qty: input.qty, note: input.note },
    });

    return this.readOne(storeId, input.variantId);
  }

  /**
   * A correction, in either direction.
   *
   * The ledger is append-only, so nothing is edited: a count that was wrong is
   * fixed by recording the difference, and both the mistake and the correction
   * stay visible. That is the point of a ledger over a number someone edits.
   */
  async adjust(
    storeId: string,
    actorUserId: string,
    input: { variantId: string; qtyDelta: number; reason: AdjustmentReason; note?: string },
  ): Promise<StockRow> {
    if (!Number.isInteger(input.qtyDelta) || input.qtyDelta === 0) {
      throw AppError.validation("An adjustment has to be a whole number, up or down.");
    }
    if (!ADJUSTMENT_REASONS.includes(input.reason)) {
      throw AppError.validation("Choose a reason for the adjustment.");
    }
    await this.assertVariant(storeId, input.variantId);

    const current = await this.readOne(storeId, input.variantId);
    if (current.on_hand + input.qtyDelta < 0) {
      // The database CHECK would refuse this anyway; catching it here means the
      // person sees what they have rather than a constraint violation.
      throw AppError.validation(
        `That would take stock below zero — there ${current.on_hand === 1 ? "is" : "are"} ${current.on_hand} on hand.`,
      );
    }

    await this.writeMovement(storeId, {
      variantId: input.variantId,
      // Damage is its own type rather than a reason code, because "how much
      // did we break?" is a different question from "how far out was the
      // count?", and only one of them is a supplier conversation.
      type: input.reason === "DAMAGE" ? "DAMAGE" : "ADJUSTMENT",
      qtyDelta: input.qtyDelta,
      reasonCode: input.reason,
      note: input.note,
      actorUserId,
    });

    await this.audit.record({
      storeId,
      actorUserId,
      action: "inventory.adjusted",
      entityType: "product_variant",
      entityId: input.variantId,
      severity: "MEDIUM",
      after: { qtyDelta: input.qtyDelta, reason: input.reason, note: input.note },
    });

    return this.readOne(storeId, input.variantId);
  }

  /**
   * Whether to count this line at all, and when to reorder it.
   *
   * Tracking is off by default: a kitchen selling made-to-order food should not
   * have checkout blocked by a number nobody maintains.
   */
  async setTracking(
    storeId: string,
    actorUserId: string,
    variantId: string,
    input: { tracked: boolean; reorderPoint?: number | null; reorderQty?: number | null },
  ): Promise<StockRow> {
    if ((input.reorderPoint ?? 0) < 0 || (input.reorderQty ?? 0) < 0) {
      throw AppError.validation("Reorder numbers cannot be negative.");
    }
    await this.assertVariant(storeId, variantId);

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        INSERT INTO stock_levels (variant_id, store_id, on_hand, reserved, tracked,
                                  reorder_point, reorder_qty, updated_at)
        VALUES (${variantId}, ${storeId}, 0, 0, ${input.tracked},
                ${input.reorderPoint ?? null}, ${input.reorderQty ?? null}, now())
        ON CONFLICT (variant_id) DO UPDATE SET
          tracked = EXCLUDED.tracked,
          reorder_point = EXCLUDED.reorder_point,
          reorder_qty = EXCLUDED.reorder_qty,
          updated_at = now()
      `,
    );

    await this.audit.record({
      storeId,
      actorUserId,
      action: "inventory.tracking_changed",
      entityType: "product_variant",
      entityId: variantId,
      after: { ...input },
    });

    return this.readOne(storeId, variantId);
  }

  /**
   * Every movement for one line, newest first. The audit trail staff read.
   *
   * Names are resolved in a second, platform-scoped read rather than joined.
   * The `users` policy only exposes members of the current store, and a store
   * owner has no membership until they accept an invitation — so the obvious
   * LEFT JOIN renders "who received this delivery" as blank for exactly the
   * person most likely to have received it.
   */
  async movements(storeId: string, variantId: string, limit = 100) {
    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<
        {
          id: string;
          type: string;
          qty_delta: number;
          reason_code: string | null;
          note: string | null;
          order_id: string | null;
          actor_user_id: string | null;
          created_at: Date;
        }[]
      >`
        SELECT id, type::text, qty_delta, reason_code, note, order_id, actor_user_id, created_at
        FROM stock_movements
        WHERE store_id = ${storeId} AND variant_id = ${variantId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `,
    );

    const actorIds = [...new Set(rows.map((r) => r.actor_user_id).filter(Boolean))] as string[];
    const names = await this.actorNames(actorIds);

    return rows.map(({ actor_user_id, ...row }) => ({
      ...row,
      actor_name: actor_user_id ? (names.get(actor_user_id) ?? null) : null,
    }));
  }

  private async actorNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id, name FROM users WHERE id = ANY(${ids})`,
    );
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Writes to the ledger. The trigger maintains `stock_levels` from it.
   *
   * Nothing in this service ever updates `on_hand` directly — that is what
   * makes the level provably equal to the sum of its movements rather than a
   * second number that drifts.
   */
  private async writeMovement(
    storeId: string,
    input: {
      variantId: string;
      type: "RECEIVE" | "ADJUSTMENT" | "DAMAGE" | "COUNT";
      qtyDelta: number;
      reasonCode?: string;
      note?: string;
      actorUserId: string;
    },
  ): Promise<void> {
    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        INSERT INTO stock_movements
          (id, store_id, variant_id, type, qty_delta, reason_code, note, actor_user_id, created_at)
        VALUES (${randomUUID()}, ${storeId}, ${input.variantId},
                ${input.type}::"StockMovementType", ${input.qtyDelta},
                ${input.reasonCode ?? null}, ${input.note ?? null},
                ${input.actorUserId}, now())
      `,
    );
  }

  private async assertVariant(storeId: string, variantId: string): Promise<void> {
    const [row] = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM product_variants
        WHERE id = ${variantId} AND store_id = ${storeId} AND deleted_at IS NULL
      `,
    );
    if (!row) throw AppError.notFound();
  }

  private async readOne(storeId: string, variantId: string): Promise<StockRow> {
    const [row] = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<StockRow[]>`
        SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name,
               v.attrs, v.sku,
               COALESCE(sl.on_hand, 0) AS on_hand,
               COALESCE(sl.reserved, 0) AS reserved,
               COALESCE(sl.on_hand, 0) - COALESCE(sl.reserved, 0) AS available,
               sl.reorder_point, sl.reorder_qty,
               COALESCE(sl.tracked, false) AS tracked
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        LEFT JOIN stock_levels sl ON sl.variant_id = v.id
        WHERE v.id = ${variantId} AND v.store_id = ${storeId}
      `,
    );
    if (!row) throw AppError.notFound();
    return row;
  }
}
