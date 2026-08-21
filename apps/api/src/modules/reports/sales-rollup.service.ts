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
        await this.recomputeStoreProducts(store.id, window);
        await this.recomputeStoreCustomers(store.id, window);
      } catch (err) {
        // One shop's bad data must not stop the rest of the platform's figures.
        this.logger.error(`Rollup failed for store ${store.id}: ${String(err)}`);
      }
    }
    return written;
  }

  /**
   * The same window, one level finer: what each line sold, per day.
   *
   * Cleared and rebuilt rather than upserted. A day here is many rows, and a
   * line that stops qualifying — its order cancelled after the fact — has
   * nothing to overwrite it and would otherwise stay counted forever. The
   * sales rollup gets away with a pure upsert because a day there is exactly
   * one row.
   *
   * Both statements run inside `withTenant`, which is a transaction, so no
   * reader sees the window empty.
   */
  async recomputeStoreProducts(storeId: string, window: RollupWindow): Promise<number> {
    return this.prisma.withTenant({ isSuperAdmin: true }, async (tx) => {
      await tx.$executeRaw`
        DELETE FROM daily_store_product_sales
        WHERE store_id = ${storeId}
          AND date BETWEEN ${window.from}::date AND ${window.to}::date
      `;

      return tx.$executeRaw`
        INSERT INTO daily_store_product_sales (
          store_id, date, line_key, variant_id, product_name, sku,
          units, revenue_cents, computed_at
        )
        SELECT
          ${storeId},
          (o.placed_at AT TIME ZONE s.timezone)::date,
          -- Ad-hoc POS lines name no catalogue item, and a NULL cannot key a
          -- row; keying those by name keeps them apart from each other.
          COALESCE(oi.variant_id, 'name:' || oi.product_name),
          oi.variant_id,
          min(oi.product_name),
          min(oi.sku),
          sum(oi.qty)::int,
          sum(oi.line_total_cents)::bigint,
          now()
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN stores s ON s.id = ${storeId}
        WHERE oi.store_id = ${storeId}
          -- On orders as well as order_items: without it the planner cannot
          -- use the store_id/placed_at index. See ADR 0003.
          AND o.store_id = ${storeId}
          AND o.status::text = ANY(${COUNTED_STATUSES as unknown as string[]})
          AND o.placed_at >= ${window.from}::date - interval '1 day'
          AND o.placed_at <  ${window.to}::date + interval '2 days'
          AND (o.placed_at AT TIME ZONE s.timezone)::date
              BETWEEN ${window.from}::date AND ${window.to}::date
        GROUP BY 2, 3, oi.variant_id
      `;
    });
  }

  /**
   * The shop's customer list, for everyone who ordered in the window.
   *
   * The other two rollups recompute a slice of *time*. This one cannot: a
   * lifetime total is not confined to a window, so a customer who ordered
   * today needs their whole history re-added, not the last three days of it.
   *
   * What keeps that bounded is recomputing only the people who were active.
   * Their full history is then an indexed lookup per customer — orders is
   * indexed on (customer_id, placed_at), and one person has a handful of
   * orders however large the shop is.
   *
   * Cleared and rebuilt for exactly those customers, like the product rollup:
   * somebody whose only order was cancelled should stop being a customer
   * rather than keep stale totals nothing will overwrite.
   */
  async recomputeStoreCustomers(storeId: string, window: RollupWindow): Promise<number> {
    return this.prisma.withTenant({ isSuperAdmin: true }, async (tx) => {
      await tx.$executeRaw`
        DELETE FROM store_customers
        WHERE store_id = ${storeId}
          AND customer_id IN (
            SELECT DISTINCT customer_id FROM orders
            WHERE store_id = ${storeId}
              AND customer_id IS NOT NULL
              AND placed_at >= ${window.from}::date - interval '1 day'
              AND placed_at <  ${window.to}::date + interval '2 days'
          )
      `;

      return tx.$executeRaw`
        INSERT INTO store_customers (
          store_id, customer_id, name, email, orders_count, lifetime_cents,
          first_order_at, last_order_at, computed_at
        )
        SELECT
          ${storeId},
          o.customer_id,
          -- Readable here only because this runs as the platform.
          min(u.name),
          min(u.email),
          count(*)::int,
          sum(o.subtotal_cents - o.discount_cents)::bigint,
          min(o.placed_at),
          max(o.placed_at),
          now()
        FROM orders o
        JOIN users u ON u.id = o.customer_id
        WHERE o.store_id = ${storeId}
          AND o.status::text = ANY(${COUNTED_STATUSES as unknown as string[]})
          AND o.customer_id IN (
            SELECT DISTINCT customer_id FROM orders
            WHERE store_id = ${storeId}
              AND customer_id IS NOT NULL
              AND placed_at >= ${window.from}::date - interval '1 day'
              AND placed_at <  ${window.to}::date + interval '2 days'
          )
        GROUP BY o.customer_id
      `;
    });
  }

  /**
   * Rebuilds a store's history. For a backfill after an import or a bug.
   *
   * Chunked, because the product rollup clears and rebuilds inside a
   * transaction and three years of it takes ~17s — past the interactive
   * transaction timeout, so the whole backfill failed at the end having done
   * nothing. A month at a time keeps each transaction short whatever the shop's
   * history looks like, and a chunk that fails leaves the ones before it done.
   *
   * The scheduled pass never comes near this: it recomputes three days.
   */
  async backfill(storeId: string, window: RollupWindow): Promise<number> {
    let days = 0;
    let lines = 0;

    for (const chunk of monthlyChunks(window)) {
      days += await this.recomputeStore(storeId, chunk);
      lines += await this.recomputeStoreProducts(storeId, chunk);
      // Customers are recomputed from their whole history each time they turn
      // up in a chunk, so a backfill revisits a regular once per month they
      // shopped in. Wasteful, and still far cheaper than the alternative of
      // grouping every order the shop has ever taken.
      await this.recomputeStoreCustomers(storeId, chunk);
    }

    this.logger.log(
      `Backfilled ${days} day(s) and ${lines} line-day(s) for ${storeId} (${window.from}…${window.to})`,
    );
    return days;
  }
}

/** Splits a window into calendar months, inclusive of both ends. */
function monthlyChunks(window: RollupWindow): RollupWindow[] {
  const chunks: RollupWindow[] = [];
  const end = new Date(`${window.to}T00:00:00Z`);
  let cursor = new Date(`${window.from}T00:00:00Z`);

  // Bounded rather than `while (cursor <= end)`: a reversed or malformed
  // window must not spin here, and 600 months is well past any real history.
  for (let i = 0; i < 600 && cursor <= end; i += 1) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const to = monthEnd < end ? monthEnd : end;
    chunks.push({ from: isoDate(cursor), to: isoDate(to) });
    cursor = new Date(to.getTime() + 86_400_000);
  }
  return chunks;
}

/** `YYYY-MM-DD` in UTC — the window is deliberately generous at both ends. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
