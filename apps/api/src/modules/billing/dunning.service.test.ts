import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryMailer } from "../../infra/mailer/mailer.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { GRACE_PERIOD_DAYS } from "./billing.service.js";
import { DunningService } from "./dunning.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

// Distinct from every other suite's ids: these run in the same database, and
// two suites sharing a store id clobber each other.
const OWNER = "d5000000-0000-4000-8000-000000000001";
const STORE = "d5000000-0000-4000-8000-00000000000a";
const OWNER_EMAIL = "dunning-owner@example.com";

const DAY_MS = 86_400_000;

let prisma: PrismaService;
let mailer: InMemoryMailer;
let dunning: DunningService;

/** WEB_ORIGIN is all the service reads. */
const config = { get: () => "http://localhost:3100" } as never;

beforeEach(async () => {
  prisma = prisma ?? new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  await cleanup();
  await seed();
  mailer = new InMemoryMailer();
  dunning = new DunningService(prisma, mailer, config);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
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
      VALUES (${OWNER},${OWNER_EMAIL}::citext,'Dana','ACTIVE',now(),now())`;
    await db.$executeRaw`
      INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                          branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
      VALUES (${STORE},'dunning-store'::citext,'Morse Ave Bakery','RETAIL','ACTIVE',${OWNER},
              'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    // Note there is deliberately no store_memberships row: an owner has no
    // membership until they accept an invitation, and this job still has to
    // find their address.
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (db) => {
    await db.$executeRaw`DELETE FROM billing_notifications WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM store_subscriptions WHERE store_id = ${STORE}`;
    await db.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await db.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
  });
}

/**
 * Puts the store into an unpaid episode that began `daysAgo` days ago.
 *
 * The timestamp is computed in SQL rather than passed in as a JavaScript
 * `Date`, because that is what the real path does — `applyProviderStatus`
 * stamps `past_due_since` with `now()`. It matters: Postgres keeps microseconds
 * and a JS `Date` keeps milliseconds, so seeding from JavaScript produces a
 * value that survives a round trip when the real one does not, and the suite
 * cannot see a bug that only appears against genuine data.
 */
async function pastDue(daysAgo: number, opts: { suspended?: boolean } = {}): Promise<Date> {
  await asAdmin((db) =>
    db.$executeRaw`
      INSERT INTO store_subscriptions
        (id, store_id, plan_code, stripe_customer_id, stripe_subscription_id,
         status, past_due_since, suspended_at)
      VALUES (gen_random_uuid(), ${STORE}, 'STANDARD', 'cus_dunning', 'sub_dunning',
              'PAST_DUE', now() - make_interval(days => ${daysAgo}::int),
              ${opts.suspended ? new Date() : null})
      ON CONFLICT (store_id) DO UPDATE SET
        status = 'PAST_DUE', past_due_since = EXCLUDED.past_due_since,
        suspended_at = EXCLUDED.suspended_at`,
  );
  const [row] = await asAdmin((db) =>
    db.$queryRaw<{ past_due_since: Date }[]>`
      SELECT past_due_since FROM store_subscriptions WHERE store_id = ${STORE}`,
  );
  return row!.past_due_since;
}

async function sentStages(): Promise<string[]> {
  return asAdmin(async (db) => {
    const rows = await db.$queryRaw<{ stage: string }[]>`
      SELECT stage::text FROM billing_notifications WHERE store_id = ${STORE} ORDER BY sent_at`;
    return rows.map((r) => r.stage);
  });
}

describe("dunning", () => {
  it("writes to the owner when the first payment fails", async () => {
    await pastDue(0);

    const sent = await dunning.run();

    expect(sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(OWNER_EMAIL);
    expect(mailer.sent[0]!.subject).toContain("Morse Ave Bakery");
    // The one thing the reader has to be able to do.
    expect(mailer.sent[0]!.body).toContain(`/store/${STORE}/ops/settings`);
    expect(await sentStages()).toEqual(["PAYMENT_FAILED"]);
  });

  /**
   * The job runs hourly across a seven-day grace period — 168 passes. Without
   * the unique index and this check it would be 168 emails.
   */
  it("does not say the same thing twice", async () => {
    await pastDue(0);

    await dunning.run();
    await dunning.run();
    await dunning.run();

    expect(mailer.sent).toHaveLength(1);
    expect(await sentStages()).toEqual(["PAYMENT_FAILED"]);
  });

  it("escalates as the grace period runs down", async () => {
    const since = await pastDue(0);
    await dunning.run();

    await dunning.run(new Date(since.getTime() + 3 * DAY_MS));
    await dunning.run(new Date(since.getTime() + (GRACE_PERIOD_DAYS - 1) * DAY_MS));

    expect(await sentStages()).toEqual(["PAYMENT_FAILED", "GRACE_REMINDER", "FINAL_WARNING"]);
    expect(mailer.sent[2]!.subject).toMatch(/goes offline/);
  });

  /**
   * A worker that was down for four days must not greet the owner with the
   * whole backlog: only the last message still describes their situation.
   */
  it("sends only the current warning after the worker was down", async () => {
    const since = await pastDue(0);

    await dunning.run(new Date(since.getTime() + (GRACE_PERIOD_DAYS - 1) * DAY_MS));

    expect(mailer.sent).toHaveLength(1);
    expect(await sentStages()).toEqual(["FINAL_WARNING"]);
  });

  it("says so once the storefront is actually hidden", async () => {
    await pastDue(GRACE_PERIOD_DAYS + 1, { suspended: true });

    await dunning.run();

    expect(await sentStages()).toEqual(["SUSPENDED"]);
    expect(mailer.sent[0]!.subject).toContain("is now offline");
    // Suspension hides the storefront and nothing else, and the owner of a
    // shop that has just gone dark needs telling that in the first breath.
    expect(mailer.sent[0]!.body).toContain("Nothing has been deleted");
  });

  it("warns again when a store lapses a second time", async () => {
    await pastDue(0);
    await dunning.run();
    expect(mailer.sent).toHaveLength(1);

    // They pay, and months later the replacement card fails too. Keying the
    // record on the store rather than the episode would leave them silently
    // unwarned forever after their first lapse.
    await asAdmin((db) =>
      db.$executeRaw`
        UPDATE store_subscriptions SET status = 'ACTIVE', past_due_since = NULL
        WHERE store_id = ${STORE}`,
    );
    await pastDue(0);

    await dunning.run();

    expect(mailer.sent).toHaveLength(2);
    expect(await sentStages()).toEqual(["PAYMENT_FAILED", "PAYMENT_FAILED"]);
  });

  it("leaves paid-up stores alone", async () => {
    await asAdmin((db) =>
      db.$executeRaw`
        INSERT INTO store_subscriptions (id, store_id, plan_code, status)
        VALUES (gen_random_uuid(), ${STORE}, 'STANDARD', 'ACTIVE')`,
    );

    expect(await dunning.run()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it("records the address it used, not the address today", async () => {
    await pastDue(0);
    await dunning.run();

    await asAdmin((db) =>
      db.$executeRaw`UPDATE users SET email = 'moved-on@example.com'::citext WHERE id = ${OWNER}`,
    );

    const [row] = await asAdmin((db) =>
      db.$queryRaw<{ sent_to: string }[]>`
        SELECT sent_to FROM billing_notifications WHERE store_id = ${STORE}`,
    );
    expect(row!.sent_to).toBe(OWNER_EMAIL);
  });
});
