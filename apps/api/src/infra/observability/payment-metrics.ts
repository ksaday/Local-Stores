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

/**
 * Money taken with nothing to show for it.
 *
 * The runbook calls this the worst state in the system: a customer has been
 * charged and no order reached CONFIRMED. Until now it produced two log
 * warnings and no signal at all.
 *
 * ## Why a counter at the source, and not a gauge over the database
 *
 * The obvious shape is a scrape-time gauge — "how many succeeded payments sit
 * against an unconfirmed order right now" — matching `PipelineMetrics`. It was
 * built that way first and measured: driven from payments it costs 15ms and
 * 6,800 buffers at 420,000 rows even with a partial index, and driven from
 * orders the planner abandons the index entirely. Both scale with traffic, on
 * every scrape, forever.
 *
 * The counter is better on every axis that matters here. The condition arises
 * at exactly the sites below and nowhere else, so counting there is *exact*
 * rather than inferred from a join. It costs nothing. And it does not forget:
 * a gauge over a bounded time window drops the problem once it ages out, which
 * for money owed to a customer is precisely backwards, while
 * `increase(...[24h])` still finds an occurrence from this morning.
 *
 * The one thing a counter cannot say is whether the money is *still*
 * unreconciled — it records that it happened, not that it is outstanding. That
 * is the right division: "it happened" is the alert, and resolution is a human
 * with the authority to refund. The standing view belongs in a reconciliation
 * report an admin opens, not in a fifteen-second scrape.
 */
export const paymentsUnreconciled = new Counter({
  name: "payments_unreconciled_total",
  help: "Payments that succeeded at the provider without an order reaching CONFIRMED. Any increase needs a human.",
  labelNames: ["cause"],
  registers: [registry],
});

/**
 * Every way money can be taken without an order to show for it.
 *
 * Named rather than free strings so the set stays closed and the runbook can
 * enumerate them. Each maps to one site, and each means something different to
 * whoever is woken up.
 */
export const UNRECONCILED = {
  /** The webhook arrived but no store could be resolved from it. */
  NO_STORE: "no_store",
  /** No local payment row matches the intent Stripe says it charged. */
  NO_PAYMENT_ROW: "no_payment_row",
  /** The payment was recorded, but the order would not move to CONFIRMED. */
  CONFIRM_FAILED: "confirm_failed",
  /** The expiry sweeper cancelled an order that had already been paid. */
  EXPIRED_WHILE_PAID: "expired_while_paid",
} as const;

/**
 * Creates every series at zero so "none of this has happened" is visible.
 *
 * Unlike most counters, an absent series here is genuinely ambiguous: it reads
 * the same as a metric that was never wired up. For a signal nobody expects to
 * see move, an explicit zero is what distinguishes working-and-quiet from
 * silently-broken, and it lets a dashboard show a flat zero line rather than an
 * empty panel that nobody trusts.
 */
export function initPaymentMetrics(): void {
  for (const cause of Object.values(UNRECONCILED)) {
    paymentsUnreconciled.inc({ cause }, 0);
  }
}
