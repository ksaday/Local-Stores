"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CardPayment } from "../../stores/[slug]/checkout/card-payment";
import { startCardPayment, type PayState } from "./pay-actions";

const EMPTY: PayState = { clientSecret: null, publishableKey: null, amountCents: null, error: null };

function Submit({ amountLabel }: { amountLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-card bg-brand px-6 py-3 text-sm font-medium text-brand-ink disabled:opacity-60"
    >
      {pending ? "Setting up…" : `Pay ${amountLabel} by card`}
    </button>
  );
}

/**
 * Lets a customer pay for an order that is still outstanding.
 *
 * Lives on the receipt page rather than inside checkout so an abandoned
 * payment can be finished later from the same link — a card that fails at the
 * counter is usually followed by a different one a minute later, not by the
 * customer rebuilding their whole basket.
 */
export function PayPanel({
  storeId,
  orderId,
  amountLabel,
  cashEnabled,
  theme,
}: {
  storeId: string;
  orderId: string;
  amountLabel: string;
  cashEnabled: boolean;
  theme?: { primary?: string; background?: string; text?: string };
}) {
  const [state, run] = useActionState(startCardPayment, EMPTY);

  if (state.clientSecret && state.publishableKey) {
    return (
      <div className="mt-4">
        <CardPayment
          publishableKey={state.publishableKey}
          clientSecret={state.clientSecret}
          // Stripe returns the customer here after any redirect step. The
          // webhook is what actually records the payment, so this only needs
          // to be somewhere sensible to land.
          returnUrl={typeof window === "undefined" ? "" : window.location.href}
          amountLabel={amountLabel}
          appearanceTheme={theme}
        />
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      <form action={run}>
        <input type="hidden" name="storeId" value={storeId} />
        <input type="hidden" name="orderId" value={orderId} />
        {/* Stable for this mount, so a double-click reuses the same intent
            rather than creating a second one. */}
        <input type="hidden" name="idempotencyKey" value={`card-${orderId}`} />
        <Submit amountLabel={amountLabel} />
      </form>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      {cashEnabled && (
        <p className="text-sm text-ink-muted">
          Or pay in person when you collect.
        </p>
      )}
    </div>
  );
}
