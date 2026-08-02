"use client";

import { useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";

/**
 * Loaded once per publishable key, not per render.
 *
 * `loadStripe` injects a script tag; calling it inside a component would add
 * one on every re-render and reset the mounted card form underneath the
 * customer as they type.
 */
const stripeCache = new Map<string, Promise<Stripe | null>>();

function getStripe(publishableKey: string): Promise<Stripe | null> {
  const existing = stripeCache.get(publishableKey);
  if (existing) return existing;

  const loaded = loadStripe(publishableKey);
  stripeCache.set(publishableKey, loaded);
  return loaded;
}

/**
 * Card entry, hosted by Stripe.
 *
 * The Payment Element renders inside Stripe's own iframe, so card numbers are
 * typed directly into Stripe and never reach this page's JavaScript or our
 * servers. That is what keeps the platform in PCI SAQ-A scope (plan §13) —
 * it is a compliance boundary, not a convenience.
 */
export function CardPayment({
  publishableKey,
  clientSecret,
  returnUrl,
  amountLabel,
  appearanceTheme,
}: {
  publishableKey: string;
  clientSecret: string;
  returnUrl: string;
  amountLabel: string;
  appearanceTheme?: { primary?: string; background?: string; text?: string };
}) {
  return (
    <Elements
      stripe={getStripe(publishableKey)}
      options={{
        clientSecret,
        // Carries the store's own palette into Stripe's iframe, so the card
        // form does not look bolted on to the shop's storefront.
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: appearanceTheme?.primary ?? "#1a3d5c",
            colorBackground: appearanceTheme?.background ?? "#ffffff",
            colorText: appearanceTheme?.text ?? "#1a1a1a",
            borderRadius: "0.75rem",
          },
        },
      }}
    >
      <CardForm returnUrl={returnUrl} amountLabel={amountLabel} />
    </Elements>
  );
}

function CardForm({ returnUrl, amountLabel }: { returnUrl: string; amountLabel: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setError(null);

    // Stripe redirects to `returnUrl` for methods that need it (3-D Secure,
    // bank redirects). The order is confirmed by webhook either way, so the
    // customer landing back on the receipt is a presentation detail rather
    // than the thing that records the payment.
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
    });

    if (result.error) {
      // Stripe's messages are written for shoppers ("Your card was declined")
      // and are better than anything generic we would substitute.
      setError(result.error.message ?? "That payment didn't go through.");
      setSubmitting(false);
    }
    // On success the browser has already navigated away; nothing to do.
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <PaymentElement />

      {error && (
        <p role="alert" className="rounded-card border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!stripe || submitting}
        className="w-full rounded-card bg-brand px-6 py-3 text-sm font-medium text-brand-ink disabled:opacity-60"
      >
        {submitting ? "Paying…" : `Pay ${amountLabel}`}
      </button>

      <p className="text-center text-xs text-ink-muted">
        Card details go straight to Stripe. This shop and this site never see them.
      </p>
    </form>
  );
}
