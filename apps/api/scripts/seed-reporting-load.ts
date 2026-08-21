/**
 * Generates a large order history, so reporting is written against the data
 * volume it will actually meet (plan Phase 10 risk: "write them against a
 * seeded 1M-row dataset from the start").
 *
 * The seed in `prisma/seed-dev.ts` builds a shop somebody can use — five
 * orders, readable, good for developing a screen. It is useless for judging a
 * query: every plan is a sequential scan and every scan is instant. A report
 * that feels fine on five orders and takes forty seconds on three years of
 * them is the failure this exists to catch, and it is only catchable before
 * the queries are built on top of.
 *
 *   npx tsx scripts/seed-reporting-load.ts --orders=1000000
 *
 * Writes to its own store so it cannot be mistaken for real trade, and can be
 * removed in one statement.
 */
import { PrismaClient } from "@prisma/client";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);

const ORDERS = Number(args.get("orders") ?? 1_000_000);
const YEARS = Number(args.get("years") ?? 3);
/** Big enough that the per-statement overhead disappears, small enough to watch. */
const BATCH = 50_000;

const STORE_ID = "10adbeef-0000-4000-8000-000000000001";
const OWNER_ID = "10adbeef-0000-4000-8000-000000000002";

const prisma = new PrismaClient();

async function main() {
  console.log(`Seeding ${ORDERS.toLocaleString()} orders across ${YEARS} years…`);
  const started = Date.now();

  await prisma.$executeRawUnsafe(`
    INSERT INTO users (id, email, name, status, created_at, updated_at)
    VALUES ('${OWNER_ID}', 'load-owner@example.test'::citext, 'Load Owner', 'ACTIVE', now(), now())
    ON CONFLICT (id) DO NOTHING`);

  await prisma.$executeRawUnsafe(`
    INSERT INTO stores (id, slug, name, business_type, status, owner_user_id, timezone,
                        currency, branding, cash_enabled, stripe_charges_enabled,
                        platform_fee_bps, created_at, updated_at)
    VALUES ('${STORE_ID}', 'load-test-store'::citext, 'Load Test Store', 'RETAIL', 'ACTIVE',
            '${OWNER_ID}', 'America/Chicago', 'USD', '{}'::jsonb, true, false, 0, now(), now())
    ON CONFLICT (id) DO NOTHING`);

  // Start clean, so re-running does not double the history and quietly halve
  // every per-day average.
  await prisma.$executeRawUnsafe(`DELETE FROM daily_store_sales WHERE store_id = '${STORE_ID}'`);
  await prisma.$executeRawUnsafe(
    `DELETE FROM refunds WHERE store_id = '${STORE_ID}'`,
  );
  await prisma.$executeRawUnsafe(`DELETE FROM payments WHERE store_id = '${STORE_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM orders WHERE store_id = '${STORE_ID}'`);

  for (let offset = 0; offset < ORDERS; offset += BATCH) {
    const count = Math.min(BATCH, ORDERS - offset);
    await prisma.$executeRawUnsafe(`
      INSERT INTO orders (
        id, store_id, order_number, channel, fulfillment, status,
        subtotal_cents, discount_cents, tax_cents, delivery_fee_cents, tip_cents,
        total_cents, currency, placed_at, created_at, updated_at)
      SELECT
        gen_random_uuid()::text,
        '${STORE_ID}',
        'LOAD-' || v.g,
        (CASE WHEN v.r_channel < 0.30 THEN 'POS' ELSE 'ONLINE' END)::"OrderChannel",
        'PICKUP'::"Fulfillment",
        -- A realistic mix, including the two that must NOT be counted as trade.
        (ARRAY['DELIVERED','PICKED_UP','DELIVERED','CONFIRMED','CANCELLED','PENDING'])
          [1 + floor(v.r_status * 6)]::"OrderStatus",
        v.sub, v.disc, v.tax, 0, 0,
        v.sub - v.disc + v.tax,
        'USD', v.ts, v.ts, v.ts
      FROM (
        SELECT
          b.g, b.sub, b.ts, b.r_channel, b.r_status,
          (b.sub * 0.1 * random())::int AS disc,
          (b.sub * 0.1025)::int          AS tax
        FROM (
          SELECT
            g,
            (500 + floor(random() * 9500))::int AS sub,
            random() AS r_channel,
            random() AS r_status,
            -- Days and hours, never random() times an interval of years: that
            -- form scales the interval's month component, which stays
            -- integral, so the whole run lands on about thirty timestamps.
            --
            -- And this must be a subquery over generate_series rather than an
            -- uncorrelated CROSS JOIN LATERAL. A lateral that references
            -- nothing from the outer row is evaluated *once per statement* —
            -- every order in a 50,000-row batch then shares one timestamp, and
            -- a million orders collapse onto one day per batch. The table
            -- still looks full and the date range still looks right, so the
            -- only symptom is that the thing being measured quietly is not
            -- there.
            --
            -- The hours matter too. The store is in Chicago, so an evening
            -- order is already tomorrow in UTC, which is what the rollup's
            -- timezone handling has to get right.
            now()
              - (floor(random() * ${YEARS * 365}) * interval '1 day')
              - (random() * interval '24 hours') AS ts
          FROM generate_series(${offset + 1}, ${offset + count}) g
        ) b
      ) v`);
    process.stdout.write(`\r  orders: ${(offset + count).toLocaleString()}`);
  }
  console.log();

  // Refunds need a payment to hang from, so a slice of the orders get one.
  // Enough to make the refund join do real work without doubling the seed.
  const refundable = Math.max(1, Math.floor(ORDERS * 0.02));
  console.log(`Adding ${refundable.toLocaleString()} payments and refunds…`);

  await prisma.$executeRawUnsafe(`
    INSERT INTO payments (id, store_id, order_id, provider, amount_cents,
                          application_fee_cents, status, created_at, updated_at)
    SELECT gen_random_uuid()::text, '${STORE_ID}', o.id, 'STRIPE', o.total_cents, 0,
           'SUCCEEDED'::"PaymentStatus", o.placed_at, o.placed_at
    FROM orders o
    WHERE o.store_id = '${STORE_ID}'
      AND o.status::text IN ('DELIVERED','PICKED_UP')
    LIMIT ${refundable}`);

  await prisma.$executeRawUnsafe(`
    INSERT INTO refunds (id, store_id, payment_id, amount_cents, status, created_at, updated_at)
    SELECT gen_random_uuid()::text, '${STORE_ID}', p.id,
           (p.amount_cents * (0.2 + random() * 0.8))::int,
           'SUCCEEDED'::"RefundStatus",
           -- Days after the sale, so some refunds land in a later month than
           -- the order they reverse. That is the case the rollup dates by the
           -- refund rather than the sale.
           p.created_at + (random() * interval '10 days'),
           p.created_at
    FROM payments p
    WHERE p.store_id = '${STORE_ID}'`);

  await prisma.$executeRawUnsafe(`ANALYZE orders`);
  await prisma.$executeRawUnsafe(`ANALYZE refunds`);

  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) FROM orders WHERE store_id = '${STORE_ID}'`,
  );
  const count = Number(rows[0]?.count ?? 0);
  console.log(
    `Done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${count.toLocaleString()} orders.`,
  );
  console.log(`Store id: ${STORE_ID}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
