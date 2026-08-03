import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { FakePaymentProvider } from "../../infra/payments/payment.provider.fake.js";
import { AuditService } from "../audit/audit.service.js";
import { BillingService, GRACE_PERIOD_DAYS } from "./billing.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const OWNER = "d3000000-0000-4000-8000-000000000001";
const STORE = "d3000000-0000-4000-8000-00000000000a";
const OTHER_STORE = "d3000000-0000-4000-8000-00000000000b";

let prisma: PrismaService;
let provider: FakePaymentProvider;
let billing: BillingService;

/**
 * `plans` is a single global row, not tenant data — these tests rewrite it and
 * must put it back. Left unrestored, a local test run silently unconfigures
 * billing for the whole development environment: the price id set by
 * `npm run billing:sync-plan` is replaced by a fake one, and the next attempt
 * to subscribe fails against Stripe with a price that does not exist.
 */
let originalPriceId: string | null = null;

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  originalPriceId = await asAdmin(async (db) => {
    const [row] = await db.$queryRaw<{ stripe_price_id: string | null }[]>`
      SELECT stripe_price_id FROM plans WHERE code = 'STANDARD'`;
    return row?.stripe_price_id ?? null;
  });
});

afterAll(async () => {
  await cleanup();
  await asAdmin((db) =>
    db.$executeRaw`UPDATE plans SET stripe_price_id = ${originalPriceId} WHERE code = 'STANDARD'`,
  );
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await seed();
  provider = new FakePaymentProvider();
  billing = new BillingService(prisma, provider, new AuditService(prisma));
});

async function asAdmin<T>(work: (db: PrismaService) => Promise<T>): Promise<T> {
  const db = new PrismaService();
  try {
    return await work(db);
  } finally {
    await db.$disconnect();
  }
}

async function seed(): Promise<void> {
  await asAdmin(async (db) => {
    await db.$executeRaw`
      INSERT INTO users (id,email,name,status,created_at,updated_at)
      VALUES (${OWNER},'billing-owner@example.com'::citext,'Owner','ACTIVE',now(),now())`;
    for (const [id, slug] of [[STORE, "billing-store"], [OTHER_STORE, "billing-store-b"]] as const) {
      await db.$executeRaw`
        INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                            branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
        VALUES (${id},${slug}::citext,${slug},'RETAIL','ACTIVE',${OWNER},
                'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    }
    // The plan ships without a Stripe price until one is configured; tests
    // that start a subscription need one.
    await db.$executeRaw`UPDATE plans SET stripe_price_id = 'price_test_standard' WHERE code = 'STANDARD'`;
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (db) => {
    const stores = [STORE, OTHER_STORE];
    await db.$executeRaw`DELETE FROM store_subscriptions WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM audit_logs WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM outbox_events WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM products WHERE store_id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM stores WHERE id = ANY(${stores})`;
    await db.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
  });
}

async function readStore(storeId = STORE) {
  return asAdmin(async (db) => {
    const [row] = await db.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM stores WHERE id = ${storeId}`;
    return row!;
  });
}

async function readSubscription(storeId = STORE) {
  return asAdmin(async (db) => {
    const [row] = await db.$queryRaw<
      { status: string; past_due_since: Date | null; suspended_at: Date | null; stripe_subscription_id: string | null }[]
    >`SELECT status::text AS status, past_due_since, suspended_at, stripe_subscription_id
      FROM store_subscriptions WHERE store_id = ${storeId}`;
    return row ?? null;
  });
}

/** Puts a store into PAST_DUE as of `daysAgo`. */
async function makePastDue(daysAgo: number, storeId = STORE): Promise<void> {
  await asAdmin((db) =>
    db.$executeRaw`
      UPDATE store_subscriptions
      SET status = 'PAST_DUE', past_due_since = now() - (${daysAgo} || ' days')::interval
      WHERE store_id = ${storeId}`,
  );
}

describe("the plan", () => {
  it("ships exactly one plan, at $49 a month with a 30-day trial", async () => {
    const plan = await billing.currentPlan();
    expect(plan.code).toBe("STANDARD");
    expect(plan.priceCents).toBe(4900);
    expect(plan.trialDays).toBe(30);
  });

  it("cannot express a transaction fee", async () => {
    // The public commitment is that BBA takes no cut of a store's sales. A
    // plan able to express otherwise is a foot-gun sitting next to a promise,
    // so the database refuses it.
    await expect(
      asAdmin((db) => db.$executeRaw`UPDATE plans SET platform_fee_bps = 50 WHERE code = 'STANDARD'`),
    ).rejects.toThrow();
  });
});

describe("starting a subscription", () => {
  it("starts a trial without asking for a card", async () => {
    // 30 days before anyone has to enter payment details is the offer; asking
    // up front would contradict it.
    const result = await billing.startSubscription(STORE, OWNER);

    expect(result.alreadyStarted).toBe(false);
    expect(provider.subscriptionCalls[0]!.trialDays).toBe(30);

    const view = await billing.getSubscription(STORE);
    expect(view.status).toBe("TRIALING");
    expect(view.priceCents).toBe(4900);
  });

  it("does not create a second subscription when called twice", async () => {
    // Two live subscriptions would bill one shop twice for the same month.
    await billing.startSubscription(STORE, OWNER);
    const second = await billing.startSubscription(STORE, OWNER);

    expect(second.alreadyStarted).toBe(true);
    expect(provider.subscriptionCalls).toHaveLength(1);
  });

  it("reuses the billing customer rather than making another", async () => {
    await billing.startSubscription(STORE, OWNER);
    const customerCallsBefore = provider.subscriptionCalls[0]!.customerId;

    await billing.startSubscription(STORE, OWNER);
    expect(provider.subscriptionCalls[0]!.customerId).toBe(customerCallsBefore);
  });

  /**
   * Found against real Stripe, not the fake: after the store's billing
   * customer was recreated, every subscribe attempt returned a 500 for the
   * next 24 hours. The key was `sub-<storeId>` — the same for a genuinely
   * different request — and Stripe rejects a reused key whose parameters have
   * changed rather than collapsing it.
   */
  it("does not reuse an idempotency key across a changed billing customer", async () => {
    await billing.startSubscription(STORE, OWNER);
    const firstKey = provider.subscriptionCalls[0]!.idempotencyKey;

    // The customer is recreated and the subscription forgotten — what a
    // Stripe-side deletion, or a reseeded development database, looks like.
    await asAdmin((db) =>
      db.$executeRaw`
        UPDATE store_subscriptions
        SET stripe_subscription_id = NULL, stripe_customer_id = 'cus_recreated'
        WHERE store_id = ${STORE}`,
    );

    // Must not throw: the fake now rejects a reused key the way Stripe does.
    await billing.startSubscription(STORE, OWNER);

    const secondKey = provider.subscriptionCalls[1]!.idempotencyKey;
    expect(secondKey).not.toBe(firstKey);
    expect(secondKey).toContain(STORE);
  });

  it("reuses the idempotency key when nothing about the request changed", async () => {
    // A double-clicked "Start subscription" is the case the key exists for,
    // and it must still collapse to a single subscription.
    const first = await billing.startSubscription(STORE, OWNER);
    const firstKey = provider.subscriptionCalls[0]!.idempotencyKey;
    const customerId = provider.subscriptionCalls[0]!.customerId;

    // Same customer, subscription id lost — a retry after the write failed.
    await asAdmin((db) =>
      db.$executeRaw`
        UPDATE store_subscriptions SET stripe_subscription_id = NULL WHERE store_id = ${STORE}`,
    );

    const second = await billing.startSubscription(STORE, OWNER);

    expect(provider.subscriptionCalls[1]!.idempotencyKey).toBe(firstKey);
    expect(provider.subscriptionCalls[1]!.customerId).toBe(customerId);
    // Same key, so the provider hands back the original rather than billing
    // the shop for a second subscription.
    expect(second.subscriptionId).toBe(first.subscriptionId);
  });

  it("refuses clearly when no Stripe price is configured", async () => {
    await asAdmin((db) =>
      db.$executeRaw`UPDATE plans SET stripe_price_id = NULL WHERE code = 'STANDARD'`,
    );

    await expect(billing.startSubscription(STORE, OWNER)).rejects.toMatchObject({ status: 400 });
  });

  it("gives a portal link so the owner manages their card at Stripe", async () => {
    // Subscription card details never reach this platform, exactly as shopper
    // card details do not.
    await billing.startSubscription(STORE, OWNER);
    const url = await billing.billingPortalUrl(STORE, "http://localhost:3100/back");

    expect(url).toContain("billing.stripe.test");
  });

  it("refuses a portal link for a store that never subscribed", async () => {
    await expect(billing.billingPortalUrl(STORE, "http://x")).rejects.toMatchObject({ status: 400 });
  });
});

describe("provider status changes", () => {
  async function start() {
    await billing.startSubscription(STORE, OWNER);
    return (await readSubscription())!.stripe_subscription_id!;
  }

  it("records a move to active", async () => {
    const subId = await start();
    await billing.applyProviderStatus({
      subscriptionId: subId, status: "active", currentPeriodEnd: new Date(), trialEndsAt: null,
    });

    expect((await readSubscription())!.status).toBe("ACTIVE");
  });

  it("stamps when a store first went unpaid", async () => {
    const subId = await start();
    await billing.applyProviderStatus({
      subscriptionId: subId, status: "past_due", currentPeriodEnd: null, trialEndsAt: null,
    });

    const sub = await readSubscription();
    expect(sub!.status).toBe("PAST_DUE");
    expect(sub!.past_due_since).not.toBeNull();
  });

  it("does not restart the grace clock on each retry", async () => {
    // Stripe retries a failed card several times over days. If every retry
    // reset this, the grace period would never end and a store would trade
    // unpaid forever.
    const subId = await start();
    await billing.applyProviderStatus({
      subscriptionId: subId, status: "past_due", currentPeriodEnd: null, trialEndsAt: null,
    });
    const first = (await readSubscription())!.past_due_since;

    await billing.applyProviderStatus({
      subscriptionId: subId, status: "past_due", currentPeriodEnd: null, trialEndsAt: null,
    });

    expect((await readSubscription())!.past_due_since?.getTime()).toBe(first?.getTime());
  });

  it("clears the grace clock once payment succeeds", async () => {
    const subId = await start();
    await billing.applyProviderStatus({
      subscriptionId: subId, status: "past_due", currentPeriodEnd: null, trialEndsAt: null,
    });
    await billing.applyProviderStatus({
      subscriptionId: subId, status: "active", currentPeriodEnd: new Date(), trialEndsAt: null,
    });

    expect((await readSubscription())!.past_due_since).toBeNull();
  });

  it("treats a trial that ended without a card as unpaid, not active", async () => {
    // Stripe reports this as `paused`. Read as active, a store would trade
    // indefinitely on a subscription that never began.
    const subId = await start();
    await billing.applyProviderStatus({
      subscriptionId: subId, status: "paused", currentPeriodEnd: null, trialEndsAt: null,
    });

    expect((await readSubscription())!.status).toBe("PAST_DUE");
  });

  it("ignores a subscription id we do not know", async () => {
    const result = await billing.applyProviderStatus({
      subscriptionId: "sub_not_ours", status: "active", currentPeriodEnd: null, trialEndsAt: null,
    });
    expect(result).toBeNull();
  });
});

describe("the grace period", () => {
  async function startAndFail(daysAgo: number, storeId = STORE) {
    await billing.startSubscription(storeId, OWNER);
    await makePastDue(daysAgo, storeId);
  }

  it("leaves a store trading while it is still within grace", async () => {
    // The usual cause is an expired card, not a shop that stopped paying.
    // Taking a working business offline over a card rotation is the worse error.
    await startAndFail(GRACE_PERIOD_DAYS - 2);

    expect(await billing.suspendExpiredGracePeriods()).toBe(0);
    expect((await readStore()).status).toBe("ACTIVE");
  });

  it("suspends the store once the grace period has run out", async () => {
    await startAndFail(GRACE_PERIOD_DAYS + 1);

    expect(await billing.suspendExpiredGracePeriods()).toBe(1);
    expect((await readStore()).status).toBe("SUSPENDED");
    expect((await readSubscription())!.suspended_at).not.toBeNull();
  });

  it("keeps the lapsed store's catalog and orders intact", async () => {
    // A shop that lapses in month two and returns in month four should find
    // its products waiting (plan §18.5a).
    await asAdmin(async (db) => {
      const productId = crypto.randomUUID();
      await db.$executeRaw`
        INSERT INTO products (id,store_id,name,slug,status,created_at,updated_at)
        VALUES (${productId},${STORE},'Sourdough','sourdough','ACTIVE',now(),now())`;
    });
    await startAndFail(GRACE_PERIOD_DAYS + 1);

    await billing.suspendExpiredGracePeriods();

    const products = await asAdmin((db) =>
      db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM products WHERE store_id = ${STORE}`,
    );
    expect(Number(products[0]!.count)).toBe(1);
  });

  it("suspends only once, not on every sweep", async () => {
    await startAndFail(GRACE_PERIOD_DAYS + 1);

    expect(await billing.suspendExpiredGracePeriods()).toBe(1);
    expect(await billing.suspendExpiredGracePeriods()).toBe(0);
  });

  it("reinstates a store that pays after being suspended", async () => {
    await startAndFail(GRACE_PERIOD_DAYS + 1);
    await billing.suspendExpiredGracePeriods();
    const subId = (await readSubscription())!.stripe_subscription_id!;

    await billing.applyProviderStatus({
      subscriptionId: subId, status: "active", currentPeriodEnd: new Date(), trialEndsAt: null,
    });

    expect((await readStore()).status).toBe("ACTIVE");
    expect((await readSubscription())!.suspended_at).toBeNull();
  });

  it("does not reinstate a store a person suspended by hand", async () => {
    // A Super Admin's suspension is a different decision — fraud, a complaint,
    // a legal hold — and paying an invoice must not quietly undo it.
    await billing.startSubscription(STORE, OWNER);
    await asAdmin((db) =>
      db.$executeRaw`UPDATE stores SET status = 'SUSPENDED' WHERE id = ${STORE}`,
    );
    const subId = (await readSubscription())!.stripe_subscription_id!;

    await billing.applyProviderStatus({
      subscriptionId: subId, status: "active", currentPeriodEnd: new Date(), trialEndsAt: null,
    });

    expect((await readStore()).status).toBe("SUSPENDED");
  });

  it("suspends only the store that is overdue", async () => {
    await startAndFail(GRACE_PERIOD_DAYS + 1, STORE);
    await billing.startSubscription(OTHER_STORE, OWNER);

    await billing.suspendExpiredGracePeriods();

    expect((await readStore(STORE)).status).toBe("SUSPENDED");
    expect((await readStore(OTHER_STORE)).status).toBe("ACTIVE");
  });

  it("counts down the days remaining, for warning the owner", async () => {
    await startAndFail(2);

    const view = await billing.getSubscription(STORE);
    expect(view.graceDaysRemaining).toBe(GRACE_PERIOD_DAYS - 2);
  });

  it("reports no countdown for a store in good standing", async () => {
    await billing.startSubscription(STORE, OWNER);
    expect((await billing.getSubscription(STORE)).graceDaysRemaining).toBeNull();
  });
});
