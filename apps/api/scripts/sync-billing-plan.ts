/**
 * Creates the Stripe product and recurring price for the platform subscription,
 * and writes the price id onto the plan row.
 *
 *   npm run billing:sync-plan --workspace @bba/api
 *
 * This exists as a script rather than a migration because the price id is not
 * a property of the schema: the same migration runs against a test-mode
 * database and a live one, and each needs a *different* price id from a
 * different Stripe account. Hardcoding either would put a test price in
 * production, where every subscription attempt fails.
 *
 * Safe to run repeatedly. It finds the existing price by lookup key rather
 * than creating one each time, so re-running does not litter the Stripe
 * account with duplicate $49 prices that are impossible to tell apart.
 *
 * Which Stripe account and which database it touches come from `apps/api/.env`
 * — STRIPE_SECRET_KEY and DATABASE_URL. It must connect as the migration
 * identity, not the app role: `bba_app` is granted SELECT on plans and nothing
 * more, deliberately, because pricing is not something the application edits.
 */
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const db = new PrismaClient();

/** Same pin as the provider — an unpinned client changes on Stripe's schedule. */
const API_VERSION = "2026-07-29.dahlia" as const;

/**
 * USD, because the plan row has no currency column and the platform is
 * single-currency (Illinois launch, §18.2). If that ever stops being true, the
 * currency belongs on the plan row and not here.
 */
const CURRENCY = "usd";

type PlanRow = {
  code: string;
  name: string;
  price_cents: number;
  interval: string;
  stripe_price_id: string | null;
};

async function main(): Promise<void> {
  const secretKey = requireEnv("STRIPE_SECRET_KEY");
  const stripe = new Stripe(secretKey, { apiVersion: API_VERSION, typescript: true });

  const plan = await activePlan();
  assertModesMatch(secretKey);
  assertInterval(plan.interval);

  console.log(
    `Plan ${plan.code}: ${plan.name}, ${formatMoney(plan.price_cents)}/${plan.interval} ` +
      `(${mode(secretKey)} mode)`,
  );

  const productId = `bba-plan-${plan.code.toLowerCase()}`;
  const lookupKey = `${productId}-${plan.interval}ly`;

  const product = await ensureProduct(stripe, productId, plan);
  const price = await ensurePrice(stripe, product.id, lookupKey, plan);

  if (plan.stripe_price_id === price.id) {
    console.log(`\nAlready set: ${price.id} — nothing to do.`);
    return;
  }

  await writePriceId(plan.code, price.id);
  console.log(`\nSet plans.stripe_price_id = ${price.id} for ${plan.code}.`);
  console.log("Store owners can now start a subscription.");
}

// ── Stripe ─────────────────────────────────────────────────────────────────

/**
 * Products take a caller-chosen id, so re-running finds the same one instead
 * of creating "Standard" over and over.
 */
async function ensureProduct(
  stripe: Stripe,
  productId: string,
  plan: PlanRow,
): Promise<Stripe.Product> {
  try {
    const existing = await stripe.products.retrieve(productId);
    if (!existing.active) {
      // Archived by hand at some point. Reviving it is better than creating a
      // near-duplicate the dashboard can't distinguish.
      console.log(`Product ${productId} was archived — reactivating.`);
      return await stripe.products.update(productId, { active: true });
    }
    console.log(`Product ${productId} exists.`);
    return existing;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  const created = await stripe.products.create({
    id: productId,
    name: `BBA ${plan.name}`,
    description: "Local Stores platform subscription — online storefront, orders and payments.",
    // What the owner sees on their card statement. Worth setting explicitly:
    // the default is derived from the account name, and a shop owner who
    // cannot place a charge on their statement rings the bank, not us.
    statement_descriptor: "BBA PLATFORM",
    metadata: { planCode: plan.code },
  });
  console.log(`Created product ${created.id}.`);
  return created;
}

/**
 * Finds or creates the recurring price.
 *
 * Keyed by `lookup_key` rather than by amount: Stripe prices are immutable, so
 * a price change means a *new* price object, and matching on amount alone
 * would silently create a second one every time someone changed the plan back
 * and forth.
 */
async function ensurePrice(
  stripe: Stripe,
  productId: string,
  lookupKey: string,
  plan: PlanRow,
): Promise<Stripe.Price> {
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const existing = found.data[0];

  if (existing && matchesPlan(existing, plan)) {
    console.log(`Price ${existing.id} matches the plan.`);
    return existing;
  }

  if (existing) {
    console.log(
      `Price ${existing.id} is ${describePrice(existing)}, but the plan says ` +
        `${formatMoney(plan.price_cents)}/${plan.interval}. Creating a replacement.`,
    );
  }

  const price = await stripe.prices.create({
    product: productId,
    unit_amount: plan.price_cents,
    currency: CURRENCY,
    recurring: { interval: plan.interval as Stripe.PriceCreateParams.Recurring.Interval },
    lookup_key: lookupKey,
    // Moves the key off the old price. Without this the create fails, because
    // a lookup key can only belong to one price at a time.
    transfer_lookup_key: Boolean(existing),
    metadata: { planCode: plan.code },
  });
  console.log(`Created price ${price.id} (${describePrice(price)}).`);

  if (existing) {
    await stripe.prices.update(existing.id, { active: false });
    // Archiving stops it being *selected* again; it does not move anyone.
    // Stripe keeps billing existing subscribers on the price they signed up
    // to, which is the correct and legally safer default — changing what
    // someone already pays is a decision, not a side effect of this script.
    console.log(`Archived ${existing.id}. Existing subscribers stay on it until moved by hand.`);
  }

  return price;
}

function matchesPlan(price: Stripe.Price, plan: PlanRow): boolean {
  return (
    price.unit_amount === plan.price_cents &&
    price.currency === CURRENCY &&
    price.recurring?.interval === plan.interval &&
    price.recurring?.interval_count === 1
  );
}

function describePrice(price: Stripe.Price): string {
  const amount = price.unit_amount === null ? "no fixed amount" : formatMoney(price.unit_amount);
  return `${amount} ${price.currency.toUpperCase()}/${price.recurring?.interval ?? "one-off"}`;
}

/** Stripe reports a missing object as a 404 with this code. */
function isMissing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeError && err.code === "resource_missing";
}

// ── Database ───────────────────────────────────────────────────────────────

async function activePlan(): Promise<PlanRow> {
  // Same selection the service makes, so this configures the row that will
  // actually be used rather than whichever one sorts first.
  const rows = await db.$queryRaw<PlanRow[]>`
    SELECT code, name, price_cents, interval, stripe_price_id
    FROM plans WHERE active = true ORDER BY price_cents ASC LIMIT 1
  `;
  const plan = rows[0];
  if (!plan) {
    throw new Error(
      "No active plan row. Run `npx prisma migrate deploy` — migration 13 inserts it.",
    );
  }
  return plan;
}

async function writePriceId(code: string, priceId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    // `plans` is FORCE ROW LEVEL SECURITY and its write policy asks for the
    // platform flag. A superuser bypasses RLS anyway, but a non-superuser
    // migration role would be refused without this — and silently, as zero
    // rows updated.
    await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'true', true)`;
    const updated = await tx.$executeRaw`
      UPDATE plans SET stripe_price_id = ${priceId}, updated_at = now() WHERE code = ${code}
    `;
    if (updated !== 1) {
      throw new Error(
        `Expected to update 1 plan row, updated ${updated}. ` +
          "The connection may lack permission on plans — this must run as the migration role, not bba_app.",
      );
    }
  });
}

// ── Guards ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to apps/api/.env.`);
  return value;
}

function mode(secretKey: string): "test" | "live" {
  return secretKey.startsWith("sk_live_") ? "live" : "test";
}

/**
 * Refuses to mix a test Stripe account with a production database, in either
 * direction.
 *
 * A test price id in production means every subscription attempt fails at the
 * moment an owner tries to pay. A live key on a developer's machine is worse:
 * it creates real products in the real account, and the next person to run
 * this against production finds a price already there.
 */
function assertModesMatch(secretKey: string): void {
  const isProd = process.env.NODE_ENV === "production";
  const keyMode = mode(secretKey);
  const mismatch = (isProd && keyMode === "test") || (!isProd && keyMode === "live");
  if (!mismatch) return;

  if (process.argv.includes("--allow-mode-mismatch")) {
    console.warn(`WARNING: ${keyMode}-mode key with NODE_ENV=${process.env.NODE_ENV ?? "unset"}.`);
    return;
  }
  throw new Error(
    `Refusing to use a ${keyMode}-mode Stripe key with NODE_ENV=${process.env.NODE_ENV ?? "unset"}. ` +
      "Use the key that matches the environment, or pass --allow-mode-mismatch if this is deliberate.",
  );
}

function assertInterval(interval: string): void {
  if (!["day", "week", "month", "year"].includes(interval)) {
    throw new Error(`Plan interval "${interval}" is not one Stripe bills on.`);
  }
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

main()
  .catch((err: unknown) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
