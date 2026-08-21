/**
 * Seeds one live store with a themed storefront and a small catalog, so the
 * public pages can be exercised against real data.
 */
import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";

const db = new PrismaClient();

/**
 * Enough of a Prisma client to run raw statements. Taking this as a parameter
 * lets the cleanup be exercised inside a transaction that is then rolled back,
 * which is the only way to prove the delete order is right without destroying
 * the data you are testing against.
 */
type SeedClient = Pick<PrismaClient, "$queryRaw" | "$executeRawUnsafe">;

const STORE = "dd000000-0000-4000-8000-000000000001";
const OWNER = "dd000000-0000-4000-8000-000000000002";
const DRIVER = "dd000000-0000-4000-8000-000000000099";

/** Sign in as this to work the order queue. Dev only, obviously. */
const OWNER_EMAIL = "owner@morseavebakery.test";
const OWNER_PASSWORD = "bakery-dev-password-1";

/**
 * A second account, because the delivery screens are the one part of this app
 * you cannot see as the owner.
 *
 * A store admin passes every check a driver passes, so signing in as the owner
 * proves nothing about whether a driver can do their job — it exercises the
 * exemptions rather than the permissions. Same password: this is a dev seed,
 * and a second one to remember helps nobody.
 */
const DRIVER_EMAIL = "driver@morseavebakery.test";

/**
 * A third account, because the platform console is unreachable without one.
 *
 * Nothing creates a Super Admin — not this seed, not a setup route — so a
 * fresh clone could open every store screen and none of the platform ones.
 * The console was effectively unverifiable, which is how it ended up with no
 * figures on it for this long.
 *
 * Same password as the others. Dev only, and the seed refuses to run against a
 * database that looks like production.
 */
const PLATFORM = "dd000000-0000-4000-8000-000000000098";
const PLATFORM_EMAIL = "platform@localstores.test";

/** Every account this seed owns, so re-running it can clear all of them. */
const SEEDED_USERS = [OWNER, DRIVER, PLATFORM];

const PRODUCTS = [
  ["Sourdough Loaf", "Bread", 800, "Naturally leavened, 48-hour cold ferment.", "Morse Bakehouse"],
  ["Rye Bread", "Bread", 650, "Dense caraway rye baked every morning.", null],
  ["Almond Croissant", "Pastries", 425, "Twice-baked, filled with almond cream.", null],
  ["Cinnamon Roll", "Pastries", 475, "Cardamom-spiced, iced while warm.", null],
  ["Bread Pudding", "Pastries", 550, "Made from yesterday's loaves.", null],
  ["Baguette", "Bread", 375, "Crackling crust, baked twice daily.", null],
] as const;

/**
 * Removes every trace of the seeded store and owner, so the seed can be re-run.
 *
 * The order is derived from the live foreign-key graph rather than written out
 * by hand. The hand-written version rotted exactly as you'd expect: it was
 * correct for the tables that existed when it was written, and every phase
 * since added another table pointing at `stores` — carts, orders, payments,
 * coupons, subscriptions — none of which it knew to clear. The symptom was a
 * foreign-key error naming a table nobody had thought about, on the second run
 * only.
 *
 * Anything reachable from `stores` or `users` is cleared children-first. A
 * table added in a later phase is handled without touching this, as long as it
 * carries `store_id` or `user_id` — and if it doesn't, the assertion below
 * says so by name instead of letting the seed fail obscurely.
 */
export async function clearSeededStore(client: SeedClient = db): Promise<void> {
  const fks = await client.$queryRaw<{ child: string; parent: string }[]>`
    SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
    FROM pg_constraint WHERE contype = 'f' AND conrelid <> confrelid
  `;
  const columns = await client.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('store_id', 'user_id')
  `;

  const parentsOf = new Map<string, string[]>();
  for (const { child, parent } of fks) {
    parentsOf.set(child, [...(parentsOf.get(child) ?? []), parent]);
  }

  // Everything that hangs off the two roots, however indirectly: order_items
  // reach `stores` only through `orders`.
  const reachable = new Set(["stores", "users"]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [child, parents] of parentsOf) {
      if (!reachable.has(child) && parents.some((p) => reachable.has(p))) {
        reachable.add(child);
        changed = true;
      }
    }
  }

  // Depth-first over "who references me", emitting after recursing, which is
  // what puts children ahead of their parents.
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (table: string): void => {
    if (visited.has(table)) return;
    visited.add(table);
    for (const [child, parents] of parentsOf) {
      if (reachable.has(child) && parents.includes(table)) visit(child);
    }
    order.push(table);
  };
  for (const table of reachable) visit(table);

  const has = (table: string, column: string): boolean =>
    columns.some((c) => c.table_name === table && c.column_name === column);

  // Reached only through a membership, so it has neither id to filter on.
  // Listed explicitly because it cannot be derived, and asserted below so a
  // second table like it can't be added silently.
  const BY_MEMBERSHIP = ["member_permission_overrides"];

  const undeletable = order.filter(
    (t) =>
      !["stores", "users", ...BY_MEMBERSHIP].includes(t) &&
      !has(t, "store_id") &&
      !has(t, "user_id"),
  );
  if (undeletable.length > 0) {
    throw new Error(
      `These tables reference the seeded store but carry neither store_id nor user_id, ` +
        `so this seed cannot clear them: ${undeletable.join(", ")}. ` +
        `Add an explicit delete for each before re-running.`,
    );
  }

  for (const table of order) {
    if (BY_MEMBERSHIP.includes(table)) {
      await client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE membership_id IN (SELECT id FROM store_memberships WHERE store_id = $1)`,
        STORE,
      );
    } else if (table === "stores") {
      await client.$executeRawUnsafe(`DELETE FROM stores WHERE id = $1`, STORE);
    } else if (table === "users") {
      // All the accounts this seed creates, not just the owner. Clearing one
      // of three left the others behind, so a second `seed:dev` died on their
      // primary keys — the seed was single-use without saying so.
      await client.$executeRawUnsafe(`DELETE FROM users WHERE id = ANY($1)`, SEEDED_USERS);
    } else if (has(table, "store_id")) {
      // Both, where a table carries both. A seeded account can hold rows
      // against a store this seed does not own — a membership on somebody's
      // load fixture, say — and clearing only by store id leaves them behind
      // to fail the foreign key when the account itself is deleted.
      if (has(table, "user_id")) {
        await client.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE store_id = $1 OR user_id = ANY($2)`,
          STORE,
          SEEDED_USERS,
        );
      } else {
        await client.$executeRawUnsafe(`DELETE FROM ${table} WHERE store_id = $1`, STORE);
      }
    } else {
      // Only these accounts' own rows: sessions, tokens, identities.
      await client.$executeRawUnsafe(`DELETE FROM ${table} WHERE user_id = ANY($1)`, SEEDED_USERS);
    }
  }
}

async function main() {
  await clearSeededStore();

  // Matches the API's argon2id parameters (plan §13.1) so the seeded owner can
  // actually sign in rather than being a row that only looks like an account.
  const passwordHash = await hash(OWNER_PASSWORD, {
    algorithm: 2,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  for (const [id, email, name] of [
    [OWNER, OWNER_EMAIL, "Dana Morse"],
    [DRIVER, DRIVER_EMAIL, "Dev Driver"],
  ] as const) {
    await db.$executeRaw`
      INSERT INTO users (id,email,name,status,password_hash,email_verified_at,created_at,updated_at)
      VALUES (${id},${email}::citext,${name},'ACTIVE',${passwordHash},now(),now(),now())`;
  }

  await db.$executeRaw`
    INSERT INTO users (id,email,name,status,platform_role,password_hash,email_verified_at,created_at,updated_at)
    VALUES (${PLATFORM},${PLATFORM_EMAIL}::citext,'Platform Admin','ACTIVE','SUPER_ADMIN',
            ${passwordHash},now(),now(),now())`;

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
  for (const [user, role] of [
    [OWNER, "STORE_ADMIN"],
    [DRIVER, "DELIVERY"],
  ] as const) {
    await db.$executeRaw`
      INSERT INTO store_memberships (id,store_id,user_id,role,status,accepted_at,created_at,updated_at)
      VALUES (gen_random_uuid(),${STORE},${user},${role}::"MembershipRole",'ACTIVE',now(),now(),now())
      ON CONFLICT (store_id,user_id) DO NOTHING`;
  }

  console.log("seeded morse-ave-bakery");
  console.log(`  storefront: /stores/morse-ave-bakery`);
  console.log(`  staff:      /store/${STORE}/ops/orders`);
  console.log(`  deliveries: /store/${STORE}/ops/deliveries`);
  console.log(`  sign in as: ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
  console.log(`          or: ${DRIVER_EMAIL} (a driver — same password)`);
  console.log(`          or: ${PLATFORM_EMAIL} (the platform console — same password)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
