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
   * Today, the last seven days and the last thirty — the owner's morning view
   * (FR-DASH-01).
   *
   * One query rather than three: the three windows nest, so a single pass over
   * the widest one can total all of them with FILTER clauses. Reading the
   * rollup, it is a scan of thirty rows.
   *
   * "Today" is the store's today. Working it out here rather than from the
   * server's clock matters for a shop whose evening is already tomorrow in
   * UTC — they would otherwise arrive in the morning to a dashboard showing
   * yesterday's takings as today's.
   */
  async summary(storeId: string): Promise<StoreSummary> {
    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<
        {
          today_net: bigint | null;
          today_orders: bigint | null;
          week_net: bigint | null;
          week_orders: bigint | null;
          month_net: bigint | null;
          month_orders: bigint | null;
          computed_at: Date | null;
        }[]
      >`
        WITH today AS (
          SELECT (now() AT TIME ZONE s.timezone)::date AS d
          FROM stores s WHERE s.id = ${storeId}
        )
        SELECT
          sum(net_cents)    FILTER (WHERE date = (SELECT d FROM today))                        AS today_net,
          sum(orders_count) FILTER (WHERE date = (SELECT d FROM today))                        AS today_orders,
          sum(net_cents)    FILTER (WHERE date > (SELECT d FROM today) - 7)                    AS week_net,
          sum(orders_count) FILTER (WHERE date > (SELECT d FROM today) - 7)                    AS week_orders,
          sum(net_cents)                                                                        AS month_net,
          sum(orders_count)                                                                     AS month_orders,
          max(computed_at)                                                                      AS computed_at
        FROM daily_store_sales
        WHERE store_id = ${storeId}
          AND date > (SELECT d FROM today) - 30
          AND date <= (SELECT d FROM today)
      `,
    );

    const r = rows[0];
    return {
      today: { netCents: Number(r?.today_net ?? 0), ordersCount: Number(r?.today_orders ?? 0) },
      last7: { netCents: Number(r?.week_net ?? 0), ordersCount: Number(r?.week_orders ?? 0) },
      last30: { netCents: Number(r?.month_net ?? 0), ordersCount: Number(r?.month_orders ?? 0) },
      computedAt: r?.computed_at ? r.computed_at.toISOString() : null,
    };
  }

  /**
   * What sold most, over a window (FR-REP-02).
   *
   * Reads `daily_store_product_sales`, not `order_items` — the same move
   * `sales()` makes, and for the reason in ADR 0003: asking the transactional
   * tables directly puts the planner on a one-row estimate under RLS.
   *
   * Measured through this method against the same million-order fixture,
   * before and after the rollup:
   *
   *            live over order_items        off the rollup
   *   30 days              292ms                     21ms
   *   90 days              884ms                     55ms
   *   1 year             2,350ms  (over target)     235ms
   *   3 years          not offered                  721ms
   *
   * The 92-day cap existed because of the middle row. It is gone, and so is
   * the ceiling that made it necessary: the cost is now (days × catalogue)
   * rather than every line the shop has ever sold.
   *
   * Grouped by line rather than by variant: "large" and "small" of the same
   * cake are different things to reorder, and an ad-hoc POS line keeps its own
   * name instead of joining a nameless bucket.
   *
   * The name shown is the most recent snapshot in the window. A product
   * renamed halfway through a quarter should read as what it is called now,
   * while the figures underneath stay whatever was actually sold.
   */
  async topProducts(
    storeId: string,
    input: { from: string; to: string; limit?: number },
  ): Promise<ProductSales[]> {
    const from = parseDate(input.from, "from");
    const to = parseDate(input.to, "to");
    if (to < from) throw AppError.validation("The end of the range is before the start.");

    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > MAX_DAYS) {
      throw AppError.validation(`That range is longer than ${Math.floor(MAX_DAYS / 365)} years.`);
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
          (array_agg(variant_id ORDER BY date DESC))[1]   AS variant_id,
          (array_agg(product_name ORDER BY date DESC))[1] AS name,
          (array_agg(sku ORDER BY date DESC))[1]          AS sku,
          sum(units)::bigint                              AS units,
          sum(revenue_cents)::bigint                      AS revenue_cents
        FROM daily_store_product_sales
        WHERE store_id = ${storeId}
          AND date BETWEEN ${input.from}::date AND ${input.to}::date
        GROUP BY line_key
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


/** One period's headline figures. */
export interface SummaryFigures {
  netCents: number;
  ordersCount: number;
}

export interface StoreSummary {
  today: SummaryFigures;
  last7: SummaryFigures;
  last30: SummaryFigures;
  /**
   * When the rollup behind these figures last ran, or null if it never has.
   * The dashboard says so: a number with no age on it invites somebody to
   * reconcile against a till that is fifteen minutes ahead of it.
   */
  computedAt: string | null;
}

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
