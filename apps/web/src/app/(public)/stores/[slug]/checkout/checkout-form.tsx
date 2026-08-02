"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { placeOrder, quoteOrder, type CheckoutState } from "./actions";
import type { Quote } from "@/lib/storefront";

const EMPTY: CheckoutState = { quote: null, error: null, fieldErrors: {} };

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/**
 * The one button that takes a shopper's money.
 *
 * Disabled while the action is in flight, because the most common way to
 * double-order is an impatient second click on a slow connection. The
 * idempotency key behind it means even a click that gets through twice cannot
 * produce two orders — this is the courtesy, that is the guarantee.
 */
function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-card bg-brand px-6 py-3 text-sm font-medium text-brand-ink disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

export function CheckoutForm({
  storeId,
  storeSlug,
  currency,
  cashEnabled,
  idempotencyKey,
  initialQuote,
}: {
  storeId: string;
  storeSlug: string;
  currency: string;
  cashEnabled: boolean;
  idempotencyKey: string;
  initialQuote: Quote | null;
}) {
  const [quoteState, runQuote] = useActionState(quoteOrder, { ...EMPTY, quote: initialQuote });
  const [placeState, runPlace] = useActionState(placeOrder, EMPTY);
  const [fulfillment, setFulfillment] = useState<"PICKUP" | "DELIVERY">("PICKUP");

  const quote = quoteState.quote ?? initialQuote;
  const error = placeState.error ?? quoteState.error;
  const canPlace = quote !== null && !(fulfillment === "DELIVERY" && quote.deliveryProblem);

  return (
    <div className="mt-8 gap-10 lg:flex">
      <div className="min-w-0 flex-1">
        {/* One form, two actions. "Update total" re-prices without placing
            anything, so a shopper sees the delivery fee before committing. */}
        <form action={runPlace} className="space-y-8">
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="storeSlug" value={storeSlug} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

          <fieldset>
            <legend className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
              How would you like it?
            </legend>
            <div className="mt-3 flex flex-wrap gap-3">
              {(["PICKUP", "DELIVERY"] as const).map((option) => (
                <label
                  key={option}
                  className={`cursor-pointer rounded-card border px-4 py-2.5 text-sm ${
                    fulfillment === option ? "border-brand text-brand" : "border-line text-ink-muted"
                  }`}
                >
                  <input
                    type="radio"
                    name="fulfillment"
                    value={option}
                    checked={fulfillment === option}
                    onChange={() => setFulfillment(option)}
                    className="sr-only"
                  />
                  {option === "PICKUP" ? "Pick up" : "Delivery"}
                </label>
              ))}
            </div>
          </fieldset>

          {fulfillment === "DELIVERY" && (
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                Where to?
              </legend>
              <Input name="line1" label="Street address" required />
              <Input name="line2" label="Apartment, suite (optional)" />
              <div className="flex gap-3">
                <Input name="city" label="City" required className="flex-1" />
                <Input name="state" label="State" required maxLength={2} className="w-24" />
                <Input name="postalCode" label="ZIP" required className="w-32" />
              </div>
              {quote?.deliveryProblem && (
                <p className="rounded-card border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
                  {quote.deliveryProblem}
                </p>
              )}
            </fieldset>
          )}

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
              How can the shop reach you?
            </legend>
            <Input name="contactEmail" label="Email" type="email" />
            <Input name="contactPhone" label="Phone" type="tel" />
            <label className="block">
              <span className="text-sm text-ink">Anything the shop should know?</span>
              <textarea
                name="customerNote"
                rows={2}
                className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2 text-ink"
              />
            </label>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
              Add a tip
            </legend>
            <p className="mt-1 text-sm text-ink-muted">Goes to the shop, in full.</p>
            <label className="mt-2 block">
              <span className="sr-only">Tip in cents</span>
              <input
                name="tipCents"
                type="number"
                min={0}
                step={50}
                defaultValue={0}
                className="w-32 rounded-card border border-line bg-surface px-3 py-2 text-ink"
              />
            </label>
          </fieldset>

          {error && (
            <p role="alert" className="rounded-card border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <button
              type="submit"
              formAction={runQuote}
              className="rounded-card border border-line px-5 py-2.5 text-sm font-medium text-ink"
            >
              Update total
            </button>
            {canPlace ? (
              <SubmitButton label="Place order" pendingLabel="Placing your order…" />
            ) : (
              <span className="rounded-card bg-surface-muted px-6 py-3 text-sm text-ink-muted">
                Place order
              </span>
            )}
          </div>

          {/* Said plainly rather than buried: nobody should reach the end of
              checkout and be surprised about how they pay. */}
          <p className="text-sm text-ink-muted">
            {cashEnabled
              ? "Pay in person when you collect or receive your order. Card payments are coming soon."
              : "Payment is arranged directly with the shop."}
          </p>
        </form>
      </div>

      <aside className="mt-10 lg:mt-0 lg:w-80 lg:shrink-0">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Summary</h2>
        {quote ? (
          <dl className="mt-4 space-y-2 rounded-card border border-line p-5 text-sm">
            <Row label="Subtotal" value={money(quote.subtotalCents, currency)} />
            {quote.deliveryFeeCents > 0 && (
              <Row label="Delivery" value={money(quote.deliveryFeeCents, currency)} />
            )}
            {quote.taxCents > 0 && (
              <Row label={quote.taxDescription} value={money(quote.taxCents, currency)} />
            )}
            {quote.tipCents > 0 && <Row label="Tip" value={money(quote.tipCents, currency)} />}
            <div className="flex items-center justify-between border-t border-line pt-3 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{money(quote.totalCents, currency)}</dd>
            </div>
            {quote.etaMinutes && (
              <p className="pt-2 text-ink-muted">Estimated {quote.etaMinutes} minutes.</p>
            )}
          </dl>
        ) : (
          <p className="mt-4 text-sm text-ink-muted">Choose pickup or delivery to see your total.</p>
        )}
      </aside>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function Input({
  name,
  label,
  type = "text",
  required = false,
  maxLength,
  className = "",
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  maxLength?: number;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-sm text-ink">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        maxLength={maxLength}
        className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2 text-ink"
      />
    </label>
  );
}
