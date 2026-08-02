/**
 * Seeds one live store with a themed storefront and a small catalog, so the
 * public pages can be exercised against real data.
 */
import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";

const db = new PrismaClient();

const STORE = "dd000000-0000-4000-8000-000000000001";
const OWNER = "dd000000-0000-4000-8000-000000000002";

/** Sign in as this to work the order queue. Dev only, obviously. */
const OWNER_EMAIL = "owner@morseavebakery.test";
const OWNER_PASSWORD = "bakery-dev-password-1";

const PRODUCTS = [
  ["Sourdough Loaf", "Bread", 800, "Naturally leavened, 48-hour cold ferment.", "Morse Bakehouse"],
  ["Rye Bread", "Bread", 650, "Dense caraway rye baked every morning.", null],
  ["Almond Croissant", "Pastries", 425, "Twice-baked, filled with almond cream.", null],
  ["Cinnamon Roll", "Pastries", 475, "Cardamom-spiced, iced while warm.", null],
  ["Bread Pudding", "Pastries", 550, "Made from yesterday's loaves.", null],
  ["Baguette", "Bread", 375, "Crackling crust, baked twice daily.", null],
] as const;

async function main() {
  // Ledger and levels first: both reference variants, and the ledger cannot be
  // deleted by the app role at all — this script runs as the owner.
  await db.$executeRaw`DELETE FROM stock_movements WHERE store_id = ${STORE}`;
  await db.$executeRaw`DELETE FROM stock_levels WHERE store_id = ${STORE}`;
  await db.$executeRaw`DELETE FROM product_variants WHERE store_id = ${STORE}`;
  await db.$executeRaw`DELETE FROM products WHERE store_id = ${STORE}`;
  await db.$executeRaw`DELETE FROM categories WHERE store_id = ${STORE}`;
  await db.$executeRaw`DELETE FROM store_hours WHERE store_id = ${STORE}`;
  await db.$executeRaw`DELETE FROM tax_rates WHERE store_id = ${STORE}`;
  await db.$executeRaw`DELETE FROM delivery_zones WHERE store_id = ${STORE}`;
  await db.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
  await db.$executeRaw`DELETE FROM store_memberships WHERE store_id = ${STORE}`;
  await db.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;

  // Matches the API's argon2id parameters (plan §13.1) so the seeded owner can
  // actually sign in rather than being a row that only looks like an account.
  const passwordHash = await hash(OWNER_PASSWORD, {
    algorithm: 2,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  await db.$executeRaw`
    INSERT INTO users (id,email,name,status,password_hash,email_verified_at,created_at,updated_at)
    VALUES (${OWNER},${OWNER_EMAIL}::citext,'Dana Morse','ACTIVE',${passwordHash},now(),now(),now())`;

  await db.$executeRaw`
    INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,address_line1,city,state,postal_code,
                        timezone,currency,branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
    VALUES (${STORE},'morse-ave-bakery'::citext,'Morse Ave Bakery','RETAIL','ACTIVE',${OWNER},
            '1423 W Morse Ave','Chicago','IL','60626','America/Chicago','USD',
            ${JSON.stringify({
              theme: {
                primary: "#7a3b12",
                background: "#fffaf3",
                text: "#2a1c10",
                accent: "#a8621f",
              },
            })}::jsonb,
            true,false,0,now(),now())`;

  for (const [weekday, closed] of [[0, true], [1, false], [2, false], [3, false], [4, false], [5, false], [6, false]] as const) {
    await db.$executeRaw`
      INSERT INTO store_hours (id,store_id,weekday,opens,closes,is_closed)
      VALUES (gen_random_uuid(),${STORE},${weekday},'07:00','15:00',${closed})`;
  }

  // Chicago's combined rate, so checkout shows a realistic tax line.
  await db.$executeRaw`
    INSERT INTO tax_rates (id,store_id,name,rate_bps,is_default,active,created_at)
    VALUES (gen_random_uuid(),${STORE},'IL sales tax',1025,true,true,now())`;

  // A zone centred on the shop, so delivery quoting has something to hit.
  await db.$executeRaw`
    INSERT INTO delivery_zones (id,store_id,name,center_lat,center_lng,radius_meters,
                                fee_cents,min_order_cents,eta_minutes,active,created_at,updated_at)
    VALUES (gen_random_uuid(),${STORE},'Rogers Park',42.0081,-87.6698,5000,499,1500,35,true,now(),now())`;

  const categoryIds = new Map<string, string>();
  for (const name of ["Bread", "Pastries"]) {
    const id = crypto.randomUUID();
    categoryIds.set(name, id);
    await db.$executeRaw`
      INSERT INTO categories (id,store_id,name,slug,position,active,created_at,updated_at)
      VALUES (${id},${STORE},${name},${name.toLowerCase()},0,true,now(),now())`;
  }

  for (const [name, category, priceCents, description, brand] of PRODUCTS) {
    const id = crypto.randomUUID();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await db.$executeRaw`
      INSERT INTO products (id,store_id,category_id,name,slug,brand,description,status,created_at,updated_at)
      VALUES (${id},${STORE},${categoryIds.get(category)!},${name},${slug},${brand},${description},'ACTIVE',now(),now())`;
    await db.$executeRaw`
      INSERT INTO product_variants (id,store_id,product_id,price_cents,is_default,active,attrs,created_at,updated_at)
      VALUES (gen_random_uuid(),${STORE},${id},${priceCents},true,true,'{}'::jsonb,now(),now())`;
  }

  // One product gets a second, pricier variant so the price-range rendering
  // and the options list have something real to show.
  const loaf = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM products WHERE store_id = ${STORE} AND slug = 'sourdough-loaf'`;
  await db.$executeRaw`
    INSERT INTO product_variants (id,store_id,product_id,price_cents,is_default,active,attrs,created_at,updated_at)
    VALUES (gen_random_uuid(),${STORE},${loaf[0]!.id},1400,false,true,${JSON.stringify({ size: "Large" })}::jsonb,now(),now())`;

  // A draft product, to confirm by eye that it never appears publicly.
  await db.$executeRaw`
    INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
    VALUES (gen_random_uuid(),${STORE},'Test Recipe - Do Not Publish','test-recipe','DRAFT',now(),now())`;

  // Stock two lines so reservation and the sold-out path are both reachable
  // by hand; everything else stays untracked, like a made-to-order kitchen.
  for (const slug of ["sourdough-loaf", "baguette"]) {
    const [variant] = await db.$queryRaw<{ id: string }[]>`
      SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE p.store_id = ${STORE} AND p.slug = ${slug} AND v.is_default`;
    if (!variant) continue;
    await db.$executeRaw`
      INSERT INTO stock_movements (id,store_id,variant_id,type,qty_delta,note)
      VALUES (gen_random_uuid(),${STORE},${variant.id},'RECEIVE',12,'Opening stock')`;
    await db.$executeRaw`UPDATE stock_levels SET tracked = true WHERE variant_id = ${variant.id}`;
  }

  // The owner needs a membership as well as ownership: permissions resolve
  // from membership rows, so without one they can see the store and nothing in it.
  await db.$executeRaw`
    INSERT INTO store_memberships (id,store_id,user_id,role,status,accepted_at,created_at,updated_at)
    VALUES (gen_random_uuid(),${STORE},${OWNER},'STORE_ADMIN','ACTIVE',now(),now(),now())
    ON CONFLICT (store_id,user_id) DO NOTHING`;

  console.log("seeded morse-ave-bakery");
  console.log(`  storefront: /stores/morse-ave-bakery`);
  console.log(`  staff:      /store/${STORE}/ops/orders`);
  console.log(`  sign in as: ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
