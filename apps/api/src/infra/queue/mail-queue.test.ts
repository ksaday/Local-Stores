import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryMailer, MailDelivery, type OutboundEmail } from "../mailer/mailer.js";
import { QueueMailer } from "../mailer/queue.mailer.js";
import { MailProcessor } from "../../worker/mail-processor.js";
import { SEND_EMAIL_JOB } from "./mail-queue.js";
import { MailQueue } from "./queue.module.js";

const config = {
  get: (key: string) =>
    key === "REDIS_URL" ? (process.env.REDIS_URL ?? "redis://localhost:6379") : "test",
} as never;

// A queue of its own per run. Sharing the real one would mean a developer's
// running worker delivered these for real, or ate mail this suite was about to
// assert on.
let queueName: string;
let queue: MailQueue;
let processor: MailProcessor | undefined;

const EMAIL: OutboundEmail = {
  to: "owner@example.com",
  subject: "Your storefront goes offline tomorrow",
  body: "Update your card.",
  critical: true,
};

beforeEach(() => {
  queueName = `test-mail-${randomUUID().slice(0, 8)}`;
  queue = new MailQueue(config, queueName);
  processor = undefined;
});

afterEach(async () => {
  await processor?.stop();
  await queue.obliterate();
  await queue.onModuleDestroy();
});

/** Polls until `check` holds, so a test never depends on a fixed sleep. */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition never became true");
}

describe("the mail queue", () => {
  it("hands the message to the queue instead of delivering it", async () => {
    const mailer = new QueueMailer(queue);

    await mailer.send(EMAIL);

    const [job] = await queue.waiting();
    expect(job).toBeDefined();
    expect(job!.name).toBe(SEND_EMAIL_JOB);
    expect(job!.data).toEqual(EMAIL);
  });

  it("asks for five attempts with exponential backoff", async () => {
    // The plan's retry policy (§7.6). Asserted because it is the difference
    // between a provider blip costing nothing and costing a password reset.
    await new QueueMailer(queue).send(EMAIL);

    const [job] = await queue.waiting();
    expect(job!.opts.attempts).toBe(5);
    expect(job!.opts.backoff).toMatchObject({ type: "exponential" });
    // Kept rather than discarded: a failed send is the thing worth looking at.
    expect(job!.opts.removeOnFail).toBe(false);
  });

  it("delivers what was queued, once the worker picks it up", async () => {
    const delivery = new InMemoryMailer();
    await new QueueMailer(queue).send(EMAIL);

    processor = new MailProcessor(delivery, config, queueName);
    processor.start();

    await until(() => delivery.sent.length === 1);
    expect(delivery.sent[0]).toEqual(EMAIL);
  });

  it("retries a message the provider refused the first time", async () => {
    let attempts = 0;
    const flaky: MailDelivery = {
      async send() {
        attempts += 1;
        // A rate limit, a DNS blip, a provider having a moment — all recover.
        if (attempts === 1) throw new Error("451 try again later");
      },
    };
    await queue.enqueueWith(EMAIL, { attempts: 3, backoff: { type: "fixed", delay: 20 } });

    processor = new MailProcessor(flaky, config, queueName);
    processor.start();

    await until(() => attempts >= 2);
    expect(attempts).toBe(2);
    // Nothing left in the failed set: the message got through in the end.
    await until(async () => (await queue.deadLettered()) === 0);
  });

  it("keeps mail that failed every attempt, rather than dropping it", async () => {
    const broken: MailDelivery = {
      async send() {
        throw new Error("550 mailbox unavailable");
      },
    };
    await queue.enqueueWith(EMAIL, { attempts: 2, backoff: { type: "fixed", delay: 10 } });

    processor = new MailProcessor(broken, config, queueName);
    processor.start();

    // This is what the dead-letter check reports on: an email nobody received,
    // still visible rather than gone.
    await until(async () => (await queue.deadLettered()) === 1);
    expect(await queue.deadLettered()).toBe(1);
  });
});
