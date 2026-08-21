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
