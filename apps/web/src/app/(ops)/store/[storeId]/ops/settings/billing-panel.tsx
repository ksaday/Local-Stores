"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { openBillingPortal, startSubscription, type BillingActionState } from "./billing-actions";

const EMPTY: BillingActionState = { error: null };

export interface SubscriptionView {
  status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | null;
  planName: string | null;
  priceCents: number | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceDaysRemaining: number | null;
  hasPaymentMethod: boolean;
}

function Submit({ label, pending: pendingLabel }: { label: string; pending: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function date(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function BillingPanel({
  storeId,
  subscription,
}: {
  storeId: string;
  subscription: SubscriptionView;
}) {
  const [startState, runStart] = useActionState(startSubscription, EMPTY);
  const [portalState, runPortal] = useActionState(openBillingPortal, EMPTY);
  const error = startState.error ?? portalState.error;

  const { status } = subscription;

  return (
    <div className="space-y-4">
      {status === null ? (
        <>
          <p className="text-sm text-ink-muted">
            {subscription.priceCents ? money(subscription.priceCents) : "$49"} a month, with the
            first 30 days free. No card needed to start, and we never take a cut of your sales.
          </p>
          <form action={runStart}>
            <input type="hidden" name="storeId" value={storeId} />
            <Submit label="Start your free trial" pending="Starting…" />
          </form>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${
                status === "ACTIVE"
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                  : status === "TRIALING"
                    ? "bg-sky-50 text-sky-800 ring-sky-200"
                    : status === "PAST_DUE"
                      ? "bg-amber-50 text-amber-800 ring-amber-200"
                      : "bg-neutral-100 text-neutral-700 ring-neutral-300"
              }`}
            >
              {status === "TRIALING"
                ? "Free trial"
                : status === "ACTIVE"
                  ? "Active"
                  : status === "PAST_DUE"
                    ? "Payment failed"
                    : "Cancelled"}
            </span>
            {subscription.planName && subscription.priceCents !== null && (
              <span className="text-sm text-ink-muted">
                {subscription.planName} · {money(subscription.priceCents)}/month
              </span>
            )}
          </div>

          {/* The warning that matters most: say exactly how long they have and
              exactly what happens, rather than a vague "update your billing". */}
          {status === "PAST_DUE" && (
            <div className="rounded-card border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-medium">
                {subscription.graceDaysRemaining === 0
                  ? "Your storefront will be hidden today."
                  : `Your storefront will be hidden in ${subscription.graceDaysRemaining} ${
                      subscription.graceDaysRemaining === 1 ? "day" : "days"
                    }.`}
              </p>
              <p className="mt-1">
                We couldn&rsquo;t take payment — usually an expired card. Update it and
                everything comes straight back on. Nothing is deleted either way: your
                products, orders and customers stay exactly as they are.
              </p>
            </div>
          )}

          {status === "TRIALING" && subscription.trialEndsAt && (
            <p className="text-sm text-ink-muted">
              Free until {date(subscription.trialEndsAt)}. Add a card before then to keep
              trading without a break.
            </p>
          )}

          {status === "ACTIVE" && subscription.currentPeriodEnd && (
            <p className="text-sm text-ink-muted">
              Renews {date(subscription.currentPeriodEnd)}.
            </p>
          )}

          {status === "CANCELED" && (
            <p className="text-sm text-ink-muted">
              Your subscription has ended. Your catalog and order history are still here —
              start again whenever you like.
            </p>
          )}

          <form action={runPortal}>
            <input type="hidden" name="storeId" value={storeId} />
            <Submit
              label={subscription.hasPaymentMethod ? "Manage billing" : "Add a card"}
              pending="Opening…"
            />
          </form>
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
