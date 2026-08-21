import { Injectable } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";

export type Grain = "day" | "week" | "month";

export interface SalesPoint {
  /** Store-local period start, `YYYY-MM-DD`. */
  date: string;
  ordersCount: number;
  grossCents: number;
  discountsCents: number;
  taxCents: number;
  refundsCents: number;
  netCents: number;
  posOrdersCount: number;
  onlineOrdersCount: number;
}

export interface SalesReport {
  grain: Grain;
  from: string;
  to: string;
  points: SalesPoint[];
  totals: Omit<SalesPoint, "date">;
}

/** A quarter of daily points is a readable chart; a decade is a denial of service. */
const MAX_DAYS = 1_100;

/**
 * The longest window `topProducts` will answer for.
 *
 * Not a product preference — a measured ceiling. See the note on the method.
 */
const MAX_PRODUCT_DAYS = 92;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sales over a window, at day, week or month grain (FR-REP-01).
   *
   * Reads the rollup, never `orders`. That is the whole point of the rollup:
   * the cost of this query is the number of *days* in the range, not the number
   * of orders in them, so a shop's third year is as fast to chart as its first
   * week.
   *
   * Rolling up in SQL rather than in JS so a year at month grain returns twelve
   * rows over the wire instead of three hundred and sixty-five.
   */
  async sales(
    storeId: string,
    input: { from: string; to: string; grain?: Grain },
  ): Promise<SalesReport> {
    // Checked here and not only in the controller's schema, because this value
    // is about to be concatenated into SQL. A type union is a compile-time
    // promise, and the string arrives over HTTP at runtime — the two are not
    // the same guarantee, and only one of them is standing between a caller
    // and `date_trunc('<whatever they sent>', …)`.
    const grain = input.grain ?? "day";
    if (grain !== "day" && grain !== "week" && grain !== "month") {
      throw AppError.validation("Group by day, week or month.", [
        { field: "grain", code: "INVALID_GRAIN", message: "Use day, week or month." },
      ]);
    }

    const from = parseDate(input.from, "from");
    const to = parseDate(input.to, "to");

    if (to < from) throw AppError.validation("The end of the range is before the start.");
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > MAX_DAYS) {
      throw AppError.validation(`That range is longer than ${Math.floor(MAX_DAYS / 365)} years.`);
    }

    // Safe to interpolate only because of the runtime check above: `grain` is
    // now provably one of three literals, not whatever arrived in the query
    // string. The dates and the store id go as bound parameters.
    const bucket =
      grain === "day"
        ? `date`
        : `date_trunc('${grain}', date)::date`;

    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRawUnsafe<
        {
          date: Date;
          orders_count: bigint;
          gross_cents: bigint;
          discounts_cents: bigint;
          tax_cents: bigint;
          refunds_cents: bigint;
          net_cents: bigint;
          pos_orders_count: bigint;
          online_orders_count: bigint;
        }[]
      >(
        `SELECT
           ${bucket} AS date,
           sum(orders_count)::bigint        AS orders_count,
           sum(gross_cents)::bigint         AS gross_cents,
           sum(discounts_cents)::bigint     AS discounts_cents,
           sum(tax_cents)::bigint           AS tax_cents,
           sum(refunds_cents)::bigint       AS refunds_cents,
           sum(net_cents)::bigint           AS net_cents,
           sum(pos_orders_count)::bigint    AS pos_orders_count,
           sum(online_orders_count)::bigint AS online_orders_count
         FROM daily_store_sales
         WHERE store_id = $1 AND date BETWEEN $2::date AND $3::date
         GROUP BY 1
         ORDER BY 1`,
        storeId,
        input.from,
        input.to,
      ),
    );

    const points = rows.map(
      (r): SalesPoint => ({
        date: r.date.toISOString().slice(0, 10),
        ordersCount: Number(r.orders_count),
        grossCents: Number(r.gross_cents),
        discountsCents: Number(r.discounts_cents),
        taxCents: Number(r.tax_cents),
        refundsCents: Number(r.refunds_cents),
        netCents: Number(r.net_cents),
        posOrdersCount: Number(r.pos_orders_count),
        onlineOrdersCount: Number(r.online_orders_count),
      }),
    );

    return { grain, from: input.from, to: input.to, points, totals: total(points) };
  }

  /**
   * What sold most, over a window (FR-REP-02).
   *
   * Read live from `order_items` rather than from a rollup, unlike `sales()`.
   * A product rollup would be (days × catalog) rows written every pass to
   * answer a question asked far less often than the takings one.
   *
   * Measured through this method, as the restricted role, against a million
   * orders and 2.1 million lines: 30 days ~200ms, 90 days ~600ms, a year
   * ~2.4s. The 2s p95 target is why the window is capped at a quarter.
   *
   * The year case is not slow because of the aggregation — the identical query
   * runs in ~650ms as the table owner. It is slow because of RLS. The policy
   * on `orders` is an OR-chain over `current_setting(...)`, whose selectivity
   * Postgres cannot estimate, so the scan is planned at **one row** against
   * 74,000 actual. On that estimate the planner picks a nested loop and probes
   * `order_items` a quarter of a million times. Forcing the order set through
   * a MATERIALIZED CTE makes it worse, because the CTE inherits the same
   * estimate.
   *
   * That is worth knowing before the rest of the report set is written: every
   * analytical query over `orders` meets the same wall, and the fix is either
   * a rollup (which is how `sales()` sidesteps it entirely) or work on the
   * policies themselves.
   *
   * There is also deliberately no per-product order count. `count(DISTINCT
   * order_id)` measured at 1.1s of extra work on the year query to distinguish
   * "three units in one basket" from "three customers". Units and revenue
   * answer what the report is for.
   *
   * Grouped by variant: "large" and "small" of the same cake are different
   * things to reorder, and rolling them together hides which one moves.
   */
  async topProducts(
    storeId: string,
    input: { from: string; to: string; limit?: number },
  ): Promise<ProductSales[]> {
    const from = parseDate(input.from, "from");
    const to = parseDate(input.to, "to");
    if (to < from) throw AppError.validation("The end of the range is before the start.");

    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > MAX_PRODUCT_DAYS) {
      throw AppError.validation("Best sellers cover up to three months at a time.", [
        { field: "from", code: "RANGE_TOO_LONG", message: `At most ${MAX_PRODUCT_DAYS} days.` },
      ]);
    }

    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);

    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<
        {
          variant_id: string | null;
          name: string;
          sku: string | null;
          units: bigint;
          revenue_cents: bigint;
        }[]
      >`
        SELECT
          oi.variant_id,
          -- The snapshot, not the product's current name: this is what the
          -- customer was sold, and the row must still read correctly after the
          -- line is renamed or deleted from the catalog.
          min(oi.product_name)          AS name,
          min(oi.sku)                   AS sku,
          sum(oi.qty)::bigint           AS units,
          sum(oi.line_total_cents)::bigint AS revenue_cents
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.store_id = ${storeId}
          -- Redundant against the join, and not optional: without a store_id
          -- predicate on the orders table itself the planner cannot use the
          -- store_id/placed_at index, and falls back to scanning every order
          -- the shop has ever taken. It halved a thirty-day query.
          AND o.store_id = ${storeId}
          AND o.status::text = ANY(${COUNTED_STATUSES})
          AND o.placed_at >= ${input.from}::date
          AND o.placed_at < ${input.to}::date + interval '1 day'
        GROUP BY oi.variant_id
        ORDER BY revenue_cents DESC
        LIMIT ${limit}
      `,
    );

    return rows.map((r) => ({
      variantId: r.variant_id,
      name: r.name,
      sku: r.sku,
      units: Number(r.units),
      revenueCents: Number(r.revenue_cents),
    }));
  }
}

/**
 * The order states that count as trade — the same set the rollup uses.
 *
 * Refunds are deliberately not netted off here. A refund is recorded against a
 * payment, not against a line, so there is no honest way to say *which* item
 * came back: attributing it to the biggest line, or spreading it across the
 * order, would both invent a number. This report answers "what leaves the
 * shelves", and the takings report answers "what we kept".
 */
const COUNTED_STATUSES = [
  "CONFIRMED",
  "PREPARING",
  "READY",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "REFUNDED",
  "RETURNED",
];

/** What one line sold, over a window. */
export interface ProductSales {
  variantId: string | null;
  name: string;
  sku: string | null;
  units: number;
  revenueCents: number;
}

function total(points: SalesPoint[]): Omit<SalesPoint, "date"> {
  return points.reduce(
    (acc, p) => ({
      ordersCount: acc.ordersCount + p.ordersCount,
      grossCents: acc.grossCents + p.grossCents,
      discountsCents: acc.discountsCents + p.discountsCents,
      taxCents: acc.taxCents + p.taxCents,
      refundsCents: acc.refundsCents + p.refundsCents,
      netCents: acc.netCents + p.netCents,
      posOrdersCount: acc.posOrdersCount + p.posOrdersCount,
      onlineOrdersCount: acc.onlineOrdersCount + p.onlineOrdersCount,
    }),
    {
      ordersCount: 0,
      grossCents: 0,
      discountsCents: 0,
      taxCents: 0,
      refundsCents: 0,
      netCents: 0,
      posOrdersCount: 0,
      onlineOrdersCount: 0,
    },
  );
}

/** Rejects anything that is not a plain `YYYY-MM-DD`, before it reaches SQL. */
function parseDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw AppError.validation(`\`${field}\` must be a date like 2026-03-01.`, [
      { field, code: "INVALID_DATE", message: "Use YYYY-MM-DD." },
    ]);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw AppError.validation(`\`${field}\` is not a real date.`, [
      { field, code: "INVALID_DATE", message: "Use YYYY-MM-DD." },
    ]);
  }
  return d;
}
