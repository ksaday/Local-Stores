import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service.js";

export interface PlatformSummary {
  /**
   * Merchandise sold across every shop, net of discounts and refunds, over the
   * window. Not platform revenue — BBA takes no cut (§18.6), so this is a
   * measure of whether the shops are doing well, which is the leading
   * indicator for whether they keep paying.
   */
  gmvCents: number;
  ordersCount: number;

  /** Subscriptions that are actually billing, at their plan price. */
  mrrCents: number;
  /** On a free trial. Not revenue yet, and the number that predicts it. */
  trialingCount: number;
  /** Billing has failed and the grace period is running. Revenue at risk. */
  pastDueCount: number;
  pastDueCents: number;

  stores: { active: number; approved: number; suspended: number; closed: number };

  /** How fresh the sales figures are — they come from the rollup. */
  computedAt: string | null;
}

@Injectable()
export class PlatformReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The platform console's headline figures (§6.2).
   *
   * Runs super-admin scoped, which is the one context RLS is meant to let
   * across every store — the policies check `app.is_super_admin` first, so
   * these read the whole table rather than fighting the tenant clause.
   *
   * GMV comes off `daily_store_sales`, so its cost is (stores × days) and not
   * the number of orders on the platform. That matters more here than
   * anywhere: this query spans every shop at once, and is the one query whose
   * cost grows with the *business* rather than with any one customer's data.
   */
  async summary(days = 30): Promise<PlatformSummary> {
    return this.prisma.withTenant({ isSuperAdmin: true }, async (tx) => {
      const [sales] = await tx.$queryRaw<
        {
          gmv: bigint | null;
          orders: bigint | null;
          computed_at: Date | null;
        }[]
      >`
        SELECT
          sum(net_cents)::bigint    AS gmv,
          sum(orders_count)::bigint AS orders,
          max(computed_at)          AS computed_at
        FROM daily_store_sales
        WHERE date > (now() AT TIME ZONE 'UTC')::date - ${days}::int
      `;

      // Grouped in SQL rather than counted four times.
      const subs = await tx.$queryRaw<{ status: string; count: bigint; cents: bigint | null }[]>`
        SELECT s.status::text AS status, count(*)::bigint AS count, sum(p.price_cents)::bigint AS cents
        FROM store_subscriptions s
        JOIN plans p ON p.code = s.plan_code
        GROUP BY 1
      `;

      const stores = await tx.$queryRaw<{ status: string; count: bigint }[]>`
        SELECT status::text AS status, count(*)::bigint AS count FROM stores GROUP BY 1
      `;

      const sub = (status: string) => subs.find((s) => s.status === status);
      const storeCount = (status: string) =>
        Number(stores.find((s) => s.status === status)?.count ?? 0);

      return {
        gmvCents: Number(sales?.gmv ?? 0),
        ordersCount: Number(sales?.orders ?? 0),
        // ACTIVE only. A trial is not recurring revenue however likely it looks,
        // and counting it as MRR is the oldest way to flatter a dashboard.
        mrrCents: Number(sub("ACTIVE")?.cents ?? 0),
        trialingCount: Number(sub("TRIALING")?.count ?? 0),
        pastDueCount: Number(sub("PAST_DUE")?.count ?? 0),
        pastDueCents: Number(sub("PAST_DUE")?.cents ?? 0),
        stores: {
          active: storeCount("ACTIVE"),
          approved: storeCount("APPROVED"),
          suspended: storeCount("SUSPENDED"),
          closed: storeCount("CLOSED"),
        },
        computedAt: sales?.computed_at ? sales.computed_at.toISOString() : null,
      };
    });
  }
}
