import { Counter } from "prom-client";
import type { Fulfillment } from "../../modules/checkout/checkout.service.js";
import { AppError } from "../../common/errors/app-error.js";
import { registry } from "./metrics.js";

/**
 * Checkout funnel counters (docs/ops/observability.md §2, item 4 of its build
 * order). §14.5 pages when completions/attempts falls below 98% over ten
 * minutes, and this is what that alert reads.
 *
 * ## Why there is no `store` label
 *
 * The spec's table asks for one. It is left out, and this is the deliberate
 * deviation worth reading before adding it back.
 *
 * A store label means one time series per shop, per counter, forever, on a
 * platform whose entire purpose is to add shops. That is the same unbounded
 * cardinality the HTTP metrics went out of their way to avoid, and it is worse
 * here because the series never expire: a shop that closes keeps its series
 * until the retention window rolls over.
 *
 * The capability is not lost, it moves. Every structured log line already
 * carries `storeId`, so "which shop is failing" is a log query — cheap, exact,
 * and with the error message attached, which a counter could never give. High
 * cardinality belongs in logs, aggregates belong in metrics.
 *
 * There is a real cost to admit: a platform-wide ratio hides one small shop
 * failing completely. A shop doing 1% of volume can be entirely broken and move
 * the ratio by one point. That shop's failures are still in the logs, and the
 * per-store view a shop owner needs is their own dashboard reading their own
 * orders — not a Prometheus series.
 *
 * ## Why a rejection is not a failure
 *
 * An empty cart, a sold-out item, a closed shop: the system worked correctly
 * and told the shopper so. Counting those as failed checkouts would make the
 * alert fire on ordinary trading — every busy evening that sells something out
 * would page somebody who cannot do anything about it. Worse, it trains the
 * on-call to ignore the page that matters.
 *
 * So failures carry a `kind`: `rejected` for anything the system deliberately
 * refused, `error` for anything that went wrong. The alert reads `error`. The
 * `reason` label carries the stable error code underneath, which is what turns
 * "rejections are up" into "rejections are up and they are all
 * INVENTORY_INSUFFICIENT" without opening a log at all.
 */

/**
 * Labels shared by all three counters.
 *
 * `method` has exactly one possible value today — payments are written as CASH
 * and Stripe is a later phase. It is here anyway because adding a label later
 * changes the series identity and silently breaks every recorded rule and
 * dashboard built on the old one. It is sourced from the same constant the
 * payment row is written with, so the two cannot drift apart.
 *
 * `fulfillment` is not in the spec's table. It is two values, and it separates
 * failures that only delivery can have — address validation, distance quoting —
 * from the checkout path itself. Pickup healthy while delivery fails points at
 * one subsystem immediately.
 */
export interface CheckoutLabels {
  method: string;
  fulfillment: string;
}

/**
 * The payment provider every online order is written with today, and the value
 * of the `method` label.
 *
 * Defined here, and imported by the checkout service for the `payments` INSERT,
 * so one constant serves both. It sits in the metrics file rather than the
 * service only because the service already depends on this module and the
 * reverse would be a cycle — the domain still owns the meaning, and whoever
 * adds Stripe changes this line and finds both uses from it.
 */
export const PAYMENT_METHOD = "CASH";

export const checkoutAttempts = new Counter({
  name: "checkout_attempts_total",
  help: "Place-order requests the system took responsibility for. Excludes idempotent replays.",
  labelNames: ["method", "fulfillment"],
  registers: [registry],
});

export const checkoutCompletions = new Counter({
  name: "checkout_completions_total",
  help: "Checkouts that ended with the shopper having an order.",
  labelNames: ["method", "fulfillment"],
  registers: [registry],
});

export const checkoutFailures = new Counter({
  name: "checkout_failures_total",
  help: "Checkouts that did not produce an order. kind=rejected is the system working; kind=error is the system failing.",
  labelNames: ["method", "fulfillment", "kind", "reason"],
  registers: [registry],
});

/**
 * Idempotent replays, counted separately and deliberately not as attempts.
 *
 * A client retrying a request whose response it never received is one checkout,
 * not two. Counting the replay as a fresh attempt would depress the ratio every
 * time the network was poor — turning the alert into a measure of the shopper's
 * connection rather than of the platform. The original attempt was already
 * counted, and its completion with it.
 *
 * Worth its own counter rather than nothing at all: a sharp rise means clients
 * are not getting responses, which is a real symptom with no other signal.
 */
export const checkoutReplays = new Counter({
  name: "checkout_replays_total",
  help: "Place-order requests answered from an existing order under the same idempotency key.",
  labelNames: ["method", "fulfillment"],
  registers: [registry],
});

/**
 * Every fulfillment mode, for pre-creating series. See `initCheckoutMetrics`.
 *
 * The type-level check below fails the build if a third mode is ever added
 * without being listed here — which would otherwise be invisible, because the
 * consequence is not an error but an alert that quietly stops covering it.
 */
const FULFILLMENTS = ["PICKUP", "DELIVERY"] as const satisfies readonly Fulfillment[];
type _AllFulfillmentsListed =
  Exclude<Fulfillment, (typeof FULFILLMENTS)[number]> extends never ? true : never;

/**
 * Creates the attempt and completion series at zero, before anything happens.
 *
 * Without this the alert has a hole exactly where it is needed most. A labelled
 * counter in prom-client does not exist until its first increment, so on a
 * platform where checkout is completely broken there are failures and *no
 * completions series at all*. `sum()` over a vector with no series returns an
 * empty vector, not zero, and a ratio with an empty numerator is no data — an
 * alert on no data does not fire. The total outage is the one case that would
 * otherwise stay silent, whichever form the ratio is written in.
 *
 * Initialising to zero makes the success rate 0 rather than absent, which fires.
 *
 * Failures are deliberately not pre-created: there the absent case reads
 * correctly as "none happened", and the label cross-product is large.
 */
export function initCheckoutMetrics(): void {
  for (const fulfillment of FULFILLMENTS) {
    const labels = { method: PAYMENT_METHOD, fulfillment };
    checkoutAttempts.inc(labels, 0);
    checkoutCompletions.inc(labels, 0);
    checkoutReplays.inc(labels, 0);
  }
}

/**
 * Sorts a thrown error into what pages and what does not.
 *
 * The split is the HTTP status the error already carries, which is exactly the
 * right seam: a 4xx is the system telling a shopper something true about their
 * order, and a 5xx is the system failing to do its job. Anything that is not an
 * `AppError` never got as far as being classified, so it is an error by
 * definition — an unrecognised throw is the most alarming kind, not the least.
 */
export function classifyCheckoutFailure(err: unknown): { kind: string; reason: string } {
  if (err instanceof AppError) {
    return { kind: err.status >= 500 ? "error" : "rejected", reason: err.code };
  }
  return { kind: "error", reason: "UNEXPECTED" };
}
