import { beforeEach, describe, expect, it } from "vitest";
import { registry } from "./metrics.js";
import { declineReason, stripeCallDuration, timeStripeCall } from "./payment-metrics.js";

async function seriesFor(name: string) {
  const metric = await registry.getSingleMetric(name)?.get();
  return (metric?.values ?? []) as { labels: Record<string, unknown>; value: number }[];
}

describe("decline reasons as labels", () => {
  it("keeps a documented Stripe decline code", () => {
    expect(declineReason({ decline_code: "insufficient_funds" })).toBe("insufficient_funds");
  });

  it("falls back to the error code when there is no decline code", () => {
    // A payment can fail without being declined — an expired card, a bad CVC.
    expect(declineReason({ code: "expired_card" })).toBe("expired_card");
  });

  it("prefers the decline code, which is the more specific of the two", () => {
    expect(declineReason({ code: "card_declined", decline_code: "do_not_honor" })).toBe("do_not_honor");
  });

  it("says unknown rather than inventing a reason", () => {
    expect(declineReason(undefined)).toBe("unknown");
    expect(declineReason({})).toBe("unknown");
  });

  it("refuses a value that would mint a series", () => {
    // This arrives over the network from a third party and lands in a metric
    // label, which is the one place an unexpected value is not a bug but a
    // bill. Anything that is not a plain snake_case token collapses to `other`.
    expect(declineReason({ decline_code: "a".repeat(200) })).toBe("other");
    expect(declineReason({ decline_code: "card declined; id=abc123" })).toBe("other");
    expect(declineReason({ decline_code: "Insufficient-Funds" })).toBe("other");
    expect(declineReason({ decline_code: 42 })).toBe("unknown");
  });
});

describe("timing a Stripe call", () => {
  beforeEach(() => stripeCallDuration.reset());

  it("records a successful call and returns its value untouched", async () => {
    const result = await timeStripeCall("createIntent", async () => "pi_123");

    expect(result).toBe("pi_123");
    const series = await seriesFor("stripe_call_duration_seconds");
    expect(
      series.some((s) => s.labels.operation === "createIntent" && s.labels.outcome === "ok"),
    ).toBe(true);
  });

  it("records a failed call and rethrows unchanged", async () => {
    // A metrics helper that swallowed a payment error would be far worse than
    // having no metric at all.
    const boom = new Error("stripe is down");

    await expect(timeStripeCall("refund", () => Promise.reject(boom))).rejects.toBe(boom);

    const series = await seriesFor("stripe_call_duration_seconds");
    expect(series.some((s) => s.labels.operation === "refund" && s.labels.outcome === "error")).toBe(
      true,
    );
  });

  it("separates slow-and-working from slow-and-failing", async () => {
    // Both are tall bars without the outcome label, and they mean different
    // things: one is Stripe being slow, the other is usually a timeout.
    await timeStripeCall("getAccountStatus", async () => "ok");
    await expect(timeStripeCall("getAccountStatus", () => Promise.reject(new Error("x")))).rejects.toThrow();

    const counts = (await seriesFor("stripe_call_duration_seconds")).filter(
      (s) => s.labels.operation === "getAccountStatus" && s.metricName?.endsWith("_count"),
    ) as ({ labels: Record<string, unknown>; value: number; metricName?: string })[];

    const byOutcome = Object.fromEntries(counts.map((c) => [c.labels.outcome, c.value]));
    expect(byOutcome.ok).toBe(1);
    expect(byOutcome.error).toBe(1);
  });
});
