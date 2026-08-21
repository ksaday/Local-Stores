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
/** Catalog size. Enough for a long tail; a shop with ten lines ranks itself. */
const PRODUCTS = Number(args.get("products") ?? 200);
/**
 * Distinct account holders. Roughly one per twenty orders, with the rest left
 * as guests — a local shop has regulars and passers-by, and a customer report
 * that only ever sees accounts would be measured against the wrong shape.
 */
const CUSTOMERS = Number(args.get("customers") ?? 50_000);
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
  await prisma.$executeRawUnsafe(`DELETE FROM order_items WHERE store_id = '${STORE_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM orders WHERE store_id = '${STORE_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM product_variants WHERE store_id = '${STORE_ID}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM products WHERE store_id = '${STORE_ID}'`);
  // Customers last: orders reference them, so they cannot go first.
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE email LIKE 'load-customer-%'`);

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

  // Account holders, and the orders that belong to them.
  //
  // Two thirds of orders get one; the rest stay guest checkouts with only a
  // contact email. A shop's customer list is built from the accounts, so the
  // guests are what stops the report from quietly assuming every order has one.
  console.log(`Adding ${CUSTOMERS.toLocaleString()} customers…`);

  await prisma.$executeRawUnsafe(`
    INSERT INTO users (id, email, name, status, created_at, updated_at)
    SELECT gen_random_uuid()::text,
           ('load-customer-' || g || '@example.test')::citext,
           'Load Customer ' || g,
           'ACTIVE', now(), now()
    FROM generate_series(1, ${CUSTOMERS}) g
    ON CONFLICT DO NOTHING`);

  // Zipf-ish again: a few regulars carry a lot of the orders, most people
  // appear once or twice. A uniform spread would make every customer's
  // lifetime value the same and give the report nothing to rank.
  await prisma.$executeRawUnsafe(`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY email) AS n
      FROM users WHERE email LIKE 'load-customer-%'
    ),
    picked AS (
      SELECT o.id AS order_id,
             1 + floor(power(random(), 2) * ${CUSTOMERS})::int AS pick
      FROM orders o
      WHERE o.store_id = '${STORE_ID}' AND random() < 0.67
    )
    UPDATE orders o
    SET customer_id = c.id
    FROM picked p JOIN numbered c ON c.n = p.pick
    WHERE o.id = p.order_id`);

  // A catalog, and a line or three on every order.
  //
  // Without these the orders are headers with nothing in them, and any question
  // about *what* sold has nothing to read. The product report would then be
  // measured against an empty table and look instant.
  //
  // Deliberately a long tail rather than a flat spread: real shops have a few
  // lines that carry the week and a hundred that barely move, and a top-sellers
  // query over a uniform catalog does not have to rank anything.
  console.log(`Adding a ${PRODUCTS}-product catalog and order lines…`);

  await prisma.$executeRawUnsafe(`
    INSERT INTO products (id, store_id, name, slug, status, created_at, updated_at)
    SELECT gen_random_uuid()::text, '${STORE_ID}', 'Load Product ' || g,
           'load-product-' || g, 'ACTIVE'::"ProductStatus", now(), now()
    FROM generate_series(1, ${PRODUCTS}) g`);

  await prisma.$executeRawUnsafe(`
    INSERT INTO product_variants (id, product_id, store_id, sku, attrs, price_cents,
                                  is_default, active, created_at, updated_at)
    SELECT gen_random_uuid()::text, p.id, '${STORE_ID}', 'LOAD-SKU-' || p.slug,
           '{}'::jsonb, (300 + floor(random() * 4700))::int, true, true, now(), now()
    FROM products p WHERE p.store_id = '${STORE_ID}'`);

  const variants = await prisma.$queryRawUnsafe<{ id: string; name: string; price: number }[]>(
    `SELECT v.id, p.name, v.price_cents AS price
     FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.store_id = '${STORE_ID}' ORDER BY p.slug`,
  );

  // Zipf-ish weighting: variant 1 is picked far more often than variant 200,
  // so the report has a real ranking to find rather than noise.
  await prisma.$executeRawUnsafe(`
    INSERT INTO order_items (id, order_id, store_id, variant_id, product_name, variant_attrs,
                             sku, unit_price_cents, qty, line_total_cents, tax_cents)
    SELECT gen_random_uuid()::text, li.order_id, '${STORE_ID}', v.id, v.name, '{}'::jsonb,
           'LOAD-SKU-' || v.slug, v.price_cents, li.qty,
           v.price_cents * li.qty, 0
    FROM (
      SELECT o.id AS order_id,
             1 + floor(random() * 3)::int AS qty,
             -- Squaring a uniform draw biases hard towards the low indexes.
             1 + floor(power(random(), 2) * ${PRODUCTS})::int AS pick
      FROM orders o
      CROSS JOIN generate_series(1, 3) line
      WHERE o.store_id = '${STORE_ID}'
        AND random() < 0.7
    ) li
    JOIN (
      SELECT v.id, v.price_cents, p.name, p.slug,
             row_number() OVER (ORDER BY p.slug) AS n
      FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.store_id = '${STORE_ID}'
    ) v ON v.n = li.pick`);

  const [lineCount] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) FROM order_items WHERE store_id = '${STORE_ID}'`,
  );
  console.log(
    `  ${Number(lineCount?.count ?? 0).toLocaleString()} lines across ${variants.length} variants`,
  );

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

  // Let the dev owner into this store, so the reporting screens can be looked
  // at against a realistic volume rather than five hand-made orders. Without
  // it the fixture is measurable but not viewable, and half of what it is for
  // is seeing whether a chart of three years still reads.
  await prisma.$executeRawUnsafe(`
    INSERT INTO store_memberships (id, store_id, user_id, role, status, created_at, updated_at)
    SELECT gen_random_uuid()::text, '${STORE_ID}', u.id, 'STORE_ADMIN', 'ACTIVE', now(), now()
    FROM users u WHERE u.email = 'owner@morseavebakery.test'::citext
    ON CONFLICT DO NOTHING`);

  await prisma.$executeRawUnsafe(`ANALYZE orders`);
  await prisma.$executeRawUnsafe(`ANALYZE order_items`);
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
