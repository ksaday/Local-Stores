import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service.js";

/**
 * Order states that count as trade.
 *
 * PENDING is a basket somebody is still holding — it expires on its own and
 * was never money. CANCELLED did not happen. Everything else did happen, and
 * that includes REFUNDED and RETURNED: the sale was real and the money moved,
 * and undoing it is what `refunds_cents` is for. Netting a refund off by
 * removing the original order instead would make last month's takings change
 * retroactively, which is the one thing a set of books must not do.
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
] as const;

export interface RollupWindow {
  /** Store-local dates, inclusive. */
  from: string;
  to: string;
}

@Injectable()
export class SalesRollupService {
  private readonly logger = new Logger(SalesRollupService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recomputes one store's daily figures across a window.
   *
   * Recompute rather than increment. An order's status changes after it is
   * placed, a refund lands days later, and a running total nudged by each of
   * those drifts away from the orders it claims to summarise with no way to
   * notice. Rebuilding a bounded window from the source is cheap, and it is
   * self-healing: whatever went wrong yesterday is gone after the next pass.
   *
   * One statement, so a day is never briefly half-written while somebody is
   * looking at it.
   */
  async recomputeStore(storeId: string, window: RollupWindow): Promise<number> {
    const rows = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$executeRaw`
        WITH zone AS (
          SELECT timezone FROM stores WHERE id = ${storeId}
        ),
        sales AS (
          SELECT
            (o.placed_at AT TIME ZONE (SELECT timezone FROM zone))::date AS day,
            count(*)::int                                    AS orders_count,
            sum(o.subtotal_cents)::bigint                    AS gross_cents,
            sum(o.discount_cents)::bigint                    AS discounts_cents,
            sum(o.tax_cents)::bigint                         AS tax_cents,
            count(*) FILTER (WHERE o.channel = 'POS')::int    AS pos_orders_count,
            count(*) FILTER (WHERE o.channel = 'ONLINE')::int AS online_orders_count
          FROM orders o
          WHERE o.store_id = ${storeId}
            AND o.status::text = ANY(${COUNTED_STATUSES as unknown as string[]})
            -- Both halves are needed, and the plain one is not redundant.
            --
            -- The local-date test below is the correct one, but it is a
            -- function of placed_at, so the (store_id, status, placed_at)
            -- index cannot serve it: without this line Postgres sequentially
            -- scans every order the shop has ever taken to roll up three days.
            -- Measured at a million orders that is a ~300ms scan reading 62k
            -- buffers to return four rows, and it grows forever while the
            -- window stays the same size.
            --
            -- A day of slack each side covers every UTC offset (±14h at the
            -- extremes) so this can only ever be wider than the local-date
            -- window, never narrower. It exists to let the index cut the range
            -- down; the line below is what decides which day a row belongs to.
            AND o.placed_at >= ${window.from}::date - interval '1 day'
            AND o.placed_at <  ${window.to}::date + interval '2 days'
            AND (o.placed_at AT TIME ZONE (SELECT timezone FROM zone))::date
                BETWEEN ${window.from}::date AND ${window.to}::date
          GROUP BY 1
        ),
        -- Dated by when the refund was issued, not when the sale was: that is
        -- what stops a closed month from moving.
        refunded AS (
          SELECT
            (r.created_at AT TIME ZONE (SELECT timezone FROM zone))::date AS day,
            sum(r.amount_cents)::bigint AS refunds_cents
          FROM refunds r
          WHERE r.store_id = ${storeId}
            AND r.status = 'SUCCEEDED'
            -- Same shape as above, for the same reason.
            AND r.created_at >= ${window.from}::date - interval '1 day'
            AND r.created_at <  ${window.to}::date + interval '2 days'
            AND (r.created_at AT TIME ZONE (SELECT timezone FROM zone))::date
                BETWEEN ${window.from}::date AND ${window.to}::date
          GROUP BY 1
        ),
        -- FULL JOIN: a day may have refunds and no sales, which is exactly the
        -- day an owner goes looking for.
        merged AS (
          SELECT
            COALESCE(s.day, r.day)                AS day,
            COALESCE(s.orders_count, 0)           AS orders_count,
            COALESCE(s.gross_cents, 0)            AS gross_cents,
            COALESCE(s.discounts_cents, 0)        AS discounts_cents,
            COALESCE(s.tax_cents, 0)              AS tax_cents,
            COALESCE(r.refunds_cents, 0)          AS refunds_cents,
            COALESCE(s.pos_orders_count, 0)       AS pos_orders_count,
            COALESCE(s.online_orders_count, 0)    AS online_orders_count
          FROM sales s
          FULL OUTER JOIN refunded r ON r.day = s.day
        )
        INSERT INTO daily_store_sales (
          store_id, date, orders_count, gross_cents, discounts_cents, tax_cents,
          refunds_cents, net_cents, pos_orders_count, online_orders_count, computed_at
        )
        SELECT
          ${storeId}, day, orders_count, gross_cents, discounts_cents, tax_cents,
          refunds_cents,
          gross_cents - discounts_cents - refunds_cents,
          pos_orders_count, online_orders_count, now()
        FROM merged
        ON CONFLICT (store_id, date) DO UPDATE SET
          orders_count        = EXCLUDED.orders_count,
          gross_cents         = EXCLUDED.gross_cents,
          discounts_cents     = EXCLUDED.discounts_cents,
          tax_cents           = EXCLUDED.tax_cents,
          refunds_cents       = EXCLUDED.refunds_cents,
          net_cents           = EXCLUDED.net_cents,
          pos_orders_count    = EXCLUDED.pos_orders_count,
          online_orders_count = EXCLUDED.online_orders_count,
          computed_at         = now()
      `,
    );
    return rows;
  }

  /**
   * The scheduled pass: revisit the last few days for every trading store.
   *
   * A window rather than only yesterday, because the things that change a
   * finished day arrive late — a refund, an order confirmed the next morning,
   * a shop whose timezone means "yesterday" is still open. Three days covers
   * all of it and costs almost nothing; anything older needs `backfill`, and
   * needing that is a bug worth noticing rather than something to paper over
   * with a wider sweep every hour.
   */
  async runIncremental(days = 3): Promise<number> {
    const stores = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.store.findMany({
        where: { status: { in: ["ACTIVE", "SUSPENDED"] } },
        select: { id: true },
      }),
    );

    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
    const window = { from: isoDate(from), to: isoDate(to) };

    let written = 0;
    for (const store of stores) {
      try {
        written += await this.recomputeStore(store.id, window);
      } catch (err) {
        // One shop's bad data must not stop the rest of the platform's figures.
        this.logger.error(`Rollup failed for store ${store.id}: ${String(err)}`);
      }
    }
    return written;
  }

  /** Rebuilds a store's history. For a backfill after an import or a bug. */
  async backfill(storeId: string, window: RollupWindow): Promise<number> {
    const written = await this.recomputeStore(storeId, window);
    this.logger.log(`Backfilled ${written} day(s) for ${storeId} (${window.from}…${window.to})`);
    return written;
  }
}

/** `YYYY-MM-DD` in UTC — the window is deliberately generous at both ends. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
