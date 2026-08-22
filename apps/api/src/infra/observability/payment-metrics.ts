import { Counter, Histogram } from "prom-client";
import { registry } from "./metrics.js";

/**
 * Payment metrics (docs/ops/observability.md §2).
 *
 * These exist to answer one question the checkout alert cannot: when checkouts
 * stop completing, is the platform broken or are cards being declined? Those
 * look identical from the checkout ratio and need completely different
 * responses — one is an incident, the other is a Tuesday. The checkout runbook
 * sends on-call here first, and until now pointed at a metric that did not
 * exist.
 */

/**
 * The outcome of every payment attempt, by provider.
 *
 * `reason` carries Stripe's decline code — `insufficient_funds`,
 * `do_not_honor`, and so on. It is the difference between "declines are up and
 * they are all insufficient_funds", which is shoppers running out of money at
 * the end of the month, and "declines are up and they are all
 * do_not_honor", which can be a Connect account or a fraud rule and is
 * somebody's problem to fix.
 *
 * The value is sanitised before it becomes a label — see `declineReason`.
 */
export const paymentOutcomes = new Counter({
  name: "payment_outcomes_total",
  help: "Payment attempts by provider and outcome. reason carries the decline code for failures.",
  labelNames: ["provider", "outcome", "reason"],
  registers: [registry],
});

/**
 * Time spent waiting on Stripe, per operation.
 *
 * §14.5 excludes third-party time from the checkout latency SLO, which is
 * correct — we cannot be held to Stripe's response time — but it means a Stripe
 * slowdown registers nowhere at all. Checkout gets slower, the SLO stays green,
 * and nothing explains it. This is that missing signal.
 *
 * Measured around our own operation rather than around the HTTP call, so it
 * includes every request the operation makes: `createOnboardingLink` is two
 * round trips, and what matters here is how long the platform waited in total.
 *
 * Buckets run to 30s because Stripe's client is configured with a 15s timeout
 * and two network retries, so a genuinely stuck call can occupy far more than
 * any bucket sized for our own endpoints would show.
 */
export const stripeCallDuration = new Histogram({
  name: "stripe_call_duration_seconds",
  help: "Time spent inside one Stripe operation, including retries.",
  labelNames: ["operation", "outcome"],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30],
  registers: [registry],
});

/**
 * A decline code that is safe to use as a label.
 *
 * Stripe's decline codes are a documented, bounded set of snake_case tokens,
 * but this value arrives over the network from a third party and lands in a
 * metric label — the one place where an unexpected value is not a bug but a
 * bill. A malformed or unusually long code collapses to `other` rather than
 * minting a series.
 *
 * Deliberately not the human-readable `message`: that is free text, varies with
 * the card and the issuer, and would be effectively unbounded.
 */
export function declineReason(error: { decline_code?: unknown; code?: unknown } | undefined): string {
  const raw = error?.decline_code ?? error?.code;
  if (typeof raw !== "string") return "unknown";
  return /^[a-z][a-z0-9_]{0,39}$/.test(raw) ? raw : "other";
}

/**
 * Times one Stripe operation and records whether it worked.
 *
 * The `outcome` label matters as much as the duration: a call that is slow and
 * succeeding is Stripe being slow, and a call that is slow and then throwing is
 * usually a timeout. Without it both look like the same tall bar.
 *
 * Rethrows unchanged — this observes, it does not handle. A metrics helper that
 * swallowed a payment error would be far worse than no metric.
 */
export async function timeStripeCall<T>(operation: string, run: () => Promise<T>): Promise<T> {
  const started = process.hrtime.bigint();
  let outcome = "ok";
  try {
    return await run();
  } catch (err) {
    outcome = "error";
    throw err;
  } finally {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    stripeCallDuration.observe({ operation, outcome }, seconds);
  }
}
