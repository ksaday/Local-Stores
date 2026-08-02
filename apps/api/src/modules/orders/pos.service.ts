import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { TaxProvider } from "../checkout/tax.provider.js";
import { OrderEventsService } from "./order-events.service.js";

export interface PosLineInput {
  variantId: string;
  qty: number;
}

export interface PosSaleInput {
  lines: PosLineInput[];
  /** What the customer handed over. Used to compute change. */
  tenderedCents?: number;
  note?: string | null;
  /** Makes a double-tapped "Take payment" safe on a busy counter. */
  idempotencyKey: string;
}

@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: TaxProvider,
    private readonly audit: AuditService,
    private readonly events: OrderEventsService,
  ) {}

  /**
   * Finds a variant by scanned barcode or typed SKU.
   *
   * Barcode first: a scanner is the fast path, and a barcode that also happens
   * to match somebody's SKU should resolve to the scanned item. Falls back to
   * a name search so a clerk can find something whose label has worn off.
   */
  async lookup(storeId: string, code: string) {
    const trimmed = code.trim();
    if (!trimmed) return [];

    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      const exact = await tx.productVariant.findMany({
        where: {
          storeId,
          deletedAt: null,
          active: true,
          OR: [{ barcode: trimmed }, { sku: trimmed }],
          product: { status: "ACTIVE", deletedAt: null },
        },
        select: VARIANT_FIELDS,
        take: 10,
      });
      if (exact.length > 0) return exact.map(toTillItem);

      const byName = await tx.productVariant.findMany({
        where: {
          storeId,
          deletedAt: null,
          active: true,
          product: {
            status: "ACTIVE",
            deletedAt: null,
            name: { contains: trimmed, mode: "insensitive" },
          },
        },
        select: VARIANT_FIELDS,
        orderBy: { isDefault: "desc" },
        take: 20,
      });
      return byName.map(toTillItem);
    });
  }

  /** Everything sellable, for a till with no scanner and a short menu. */
  async listTillItems(storeId: string) {
    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.productVariant.findMany({
        where: {
          storeId,
          deletedAt: null,
          active: true,
          product: { status: "ACTIVE", deletedAt: null },
        },
        select: VARIANT_FIELDS,
        orderBy: [{ product: { name: "asc" } }, { isDefault: "desc" }],
        take: 200,
      }),
    );
    return rows.map(toTillItem);
  }

  /**
   * Rings up a walk-in sale.
   *
   * Deliberately not the same transaction as online checkout, because a
   * counter sale is a different event: the customer is standing there with the
   * goods and the cash. There is no reservation to hold and release — stock
   * leaves immediately — and the order is CONFIRMED and PICKED_UP the moment
   * it is rung up, because it already happened.
   */
  async ringUp(storeId: string, actorUserId: string, input: PosSaleInput) {
    if (input.lines.length === 0) throw AppError.validation("Add something to the sale first.");

    const existing = await this.findByIdempotencyKey(storeId, input.idempotencyKey);
    if (existing) return existing;

    const store = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.findFirst({
        where: { id: storeId },
        select: { id: true, name: true, currency: true, state: true, postalCode: true },
      }),
    );
    if (!store) throw AppError.notFound();

    try {
      const sale = await this.createSale(storeId, actorUserId, input, store);

      this.events.emit({
        type: "order.created",
        storeId,
        orderId: sale.id,
        orderNumber: sale.orderNumber,
        status: "PICKED_UP",
      });

      return sale;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const created = await this.findByIdempotencyKey(storeId, input.idempotencyKey);
        if (created) return created;
      }
      throw err;
    }
  }

  private async createSale(
    storeId: string,
    actorUserId: string,
    input: PosSaleInput,
    store: { name: string; currency: string; state: string | null; postalCode: string | null },
  ) {
    return this.prisma.withTenant({ storeId, userId: actorUserId, isSuperAdmin: false }, async (tx) => {
      // Price from the live catalog, never from what the till sent: a client
      // that can name its own prices is a client that can sell at zero.
      const variantIds = input.lines.map((l) => l.variantId);
      const variants = await tx.productVariant.findMany({
        where: { id: { in: variantIds }, storeId, deletedAt: null, active: true },
        select: {
          id: true, priceCents: true, sku: true, attrs: true,
          product: { select: { name: true } },
        },
      });
      const byId = new Map(variants.map((v) => [v.id, v]));

      const lines = input.lines.map((line) => {
        const variant = byId.get(line.variantId);
        if (!variant) throw AppError.validation("One of those items is no longer for sale.");
        if (!Number.isInteger(line.qty) || line.qty < 1) {
          throw AppError.validation("Quantity must be a whole number of at least 1.");
        }
        return {
          variantId: variant.id,
          productName: variant.product.name,
          variantAttrs: (variant.attrs ?? {}) as Record<string, string>,
          sku: variant.sku,
          unitPriceCents: variant.priceCents,
          qty: line.qty,
          lineTotalCents: variant.priceCents * line.qty,
        };
      });

      const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
      const taxResult = await this.tax.quote({
        storeId,
        lines,
        // A counter sale happens at the shop, so the shop's own address is
        // always the right place to source tax from.
        destination: { state: store.state, postalCode: store.postalCode },
        deliveryFeeCents: 0,
      });
      const totalCents = subtotalCents + taxResult.totalTaxCents;

      if (input.tenderedCents !== undefined && input.tenderedCents < totalCents) {
        throw AppError.validation("That's less than the total.");
      }

      // Stock goes out now. Sold items are decremented through the ledger, the
      // same path online orders use at confirmation — one way for stock to
      // leave, so the ledger stays the whole truth.
      for (const line of lines) {
        const [level] = await tx.$queryRaw<{ on_hand: number; reserved: number; tracked: boolean }[]>`
          SELECT on_hand, reserved, tracked FROM stock_levels
          WHERE variant_id = ${line.variantId} FOR UPDATE
        `;
        if (!level?.tracked) continue;

        const available = level.on_hand - level.reserved;
        if (available < line.qty) {
          // Worth blocking rather than warning: the count is what the owner
          // reconciles against, and a sale that pushes it negative is a
          // discrepancy someone has to chase later.
          throw AppError.validation(
            `Only ${Math.max(available, 0)} of "${line.productName}" left in stock.`,
          );
        }
      }

      const orderNumber = await this.nextOrderNumber(tx, storeId, store.name);
      const orderId = randomUUID();

      await tx.$executeRaw`
        INSERT INTO orders (
          id, store_id, order_number, customer_id, channel, fulfillment, status,
          subtotal_cents, discount_cents, tax_cents, delivery_fee_cents, tip_cents,
          total_cents, currency, customer_note, idempotency_key, placed_at, created_at, updated_at
        ) VALUES (
          ${orderId}, ${storeId}, ${orderNumber}, NULL, 'POS', 'PICKUP', 'PENDING',
          ${subtotalCents}, 0, ${taxResult.totalTaxCents}, 0, 0,
          ${totalCents}, ${store.currency}, ${input.note ?? null}, ${input.idempotencyKey},
          now(), now(), now()
        )
      `;

      for (const [i, line] of lines.entries()) {
        await tx.$executeRaw`
          INSERT INTO order_items (
            id, order_id, store_id, variant_id, product_name, variant_attrs, sku,
            unit_price_cents, qty, line_total_cents, tax_cents
          ) VALUES (
            ${randomUUID()}, ${orderId}, ${storeId}, ${line.variantId}, ${line.productName},
            ${JSON.stringify(line.variantAttrs)}::jsonb, ${line.sku},
            ${line.unitPriceCents}, ${line.qty}, ${line.lineTotalCents}, ${taxResult.lineTaxCents[i] ?? 0}
          )
        `;
      }

      // Straight to PICKED_UP through the legal path. The customer is holding
      // the goods; recording it as pending would be a lie the queue then shows
      // a clerk as outstanding work.
      for (const [from, to] of [
        ["PENDING", "CONFIRMED"],
        ["CONFIRMED", "PREPARING"],
        ["PREPARING", "READY"],
        ["READY", "PICKED_UP"],
      ] as const) {
        await tx.$executeRaw`
          UPDATE orders SET status = ${to}::"OrderStatus", updated_at = now() WHERE id = ${orderId}
        `;
        await tx.$executeRaw`
          INSERT INTO order_status_history (id, order_id, store_id, from_status, to_status, actor_user_id, note)
          VALUES (${randomUUID()}, ${orderId}, ${storeId}, ${from}::"OrderStatus", ${to}::"OrderStatus",
                  ${actorUserId}, ${from === "PENDING" ? "Counter sale" : null})
        `;
      }

      for (const line of lines) {
        const [level] = await tx.$queryRaw<{ tracked: boolean }[]>`
          SELECT tracked FROM stock_levels WHERE variant_id = ${line.variantId}
        `;
        if (!level?.tracked) continue;
        await tx.$executeRaw`
          INSERT INTO stock_movements (id, store_id, variant_id, type, qty_delta, order_id, actor_user_id, reason_code)
          VALUES (${randomUUID()}, ${storeId}, ${line.variantId}, 'SALE', ${-line.qty}, ${orderId},
                  ${actorUserId}, 'counter_sale')
        `;
      }

      await tx.$executeRaw`
        INSERT INTO payments (id, store_id, order_id, provider, amount_cents, application_fee_cents,
                              status, cash_received_by, cash_received_at)
        VALUES (${randomUUID()}, ${storeId}, ${orderId}, 'CASH', ${totalCents}, 0,
                'SUCCEEDED', ${actorUserId}, now())
      `;

      await this.audit.record({
        storeId,
        actorUserId,
        action: "order.pos_sale",
        entityType: "order",
        entityId: orderId,
        after: { orderNumber, totalCents },
      });

      this.logger.log(`Counter sale ${orderNumber} rung up by ${actorUserId}`);

      return {
        id: orderId,
        orderNumber,
        subtotalCents,
        taxCents: taxResult.totalTaxCents,
        totalCents,
        currency: store.currency,
        tenderedCents: input.tenderedCents ?? null,
        changeCents:
          input.tenderedCents === undefined ? null : input.tenderedCents - totalCents,
      };
    });
  }

  private async findByIdempotencyKey(storeId: string, key: string) {
    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<
        { id: string; order_number: string; subtotal_cents: number; tax_cents: number; total_cents: number; currency: string }[]
      >`
        SELECT id, order_number, subtotal_cents, tax_cents, total_cents, currency
        FROM orders WHERE store_id = ${storeId} AND idempotency_key = ${key} LIMIT 1
      `,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      orderNumber: row.order_number,
      subtotalCents: row.subtotal_cents,
      taxCents: row.tax_cents,
      totalCents: row.total_cents,
      currency: row.currency,
      tenderedCents: null,
      changeCents: null,
    };
  }

  private async nextOrderNumber(
    tx: { $queryRaw: PrismaService["$queryRaw"] },
    storeId: string,
    storeName: string,
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ value: bigint }[]>`
      INSERT INTO store_counters (store_id, key, value)
      VALUES (${storeId}, 'order', 1000)
      ON CONFLICT (store_id, key) DO UPDATE SET value = store_counters.value + 1
      RETURNING value
    `;
    const letters = storeName.replace(/[^a-zA-Z]/g, "").toUpperCase();
    return `${(letters.slice(0, 3) || "ORD").padEnd(3, "X")}-${rows[0]!.value}`;
  }
}

const VARIANT_FIELDS = {
  id: true,
  sku: true,
  barcode: true,
  attrs: true,
  priceCents: true,
  isDefault: true,
  product: { select: { name: true } },
  stockLevel: { select: { tracked: true, onHand: true, reserved: true } },
} as const;

interface RawVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  attrs: unknown;
  priceCents: number;
  isDefault: boolean;
  product: { name: string };
  stockLevel: { tracked: boolean; onHand: number; reserved: number } | null;
}

function toTillItem(variant: RawVariant) {
  return {
    variantId: variant.id,
    name: variant.product.name,
    attrs: (variant.attrs ?? {}) as Record<string, string>,
    sku: variant.sku,
    barcode: variant.barcode,
    priceCents: variant.priceCents,
    // Null means this store doesn't count this item, which the till shows
    // differently from "we have none" — they mean opposite things at a counter.
    availableQty: variant.stockLevel?.tracked
      ? Math.max(variant.stockLevel.onHand - variant.stockLevel.reserved, 0)
      : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === "P2002" || code === "23505";
}
