"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { createCoupon, type CouponActionState } from "./actions";

const EMPTY: CouponActionState = { error: null };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-60"
    >
      {pending ? "Creating…" : "Create coupon"}
    </button>
  );
}

export function CouponForm({ storeId }: { storeId: string }) {
  const [state, run] = useActionState(createCoupon, EMPTY);
  const [kind, setKind] = useState<"PERCENT" | "FIXED">("PERCENT");

  return (
    <form action={run} className="space-y-4">
      <input type="hidden" name="storeId" value={storeId} />

      <div className="flex flex-wrap gap-3">
        <label className="flex-1">
          <span className="text-sm text-ink">Code</span>
          <input
            name="code"
            required
            maxLength={40}
            placeholder="SPRING24"
            // Upper-cased here because that is how it will be stored and how
            // it appears on a flyer — a field that silently changes what you
            // typed looks broken.
            className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2 uppercase text-ink"
          />
        </label>

        <fieldset>
          <legend className="text-sm text-ink">Type</legend>
          <div className="mt-1 flex gap-2">
            {(["PERCENT", "FIXED"] as const).map((option) => (
              <label
                key={option}
                className={`cursor-pointer rounded-card border px-3 py-2 text-sm ${
                  kind === option ? "border-brand text-brand" : "border-line text-ink-muted"
                }`}
              >
                <input
                  type="radio"
                  name="kind"
                  value={option}
                  checked={kind === option}
                  onChange={() => setKind(option)}
                  className="sr-only"
                />
                {option === "PERCENT" ? "% off" : "$ off"}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="w-32">
          {/* Asked for in the units an owner thinks in — 10 for 10%, 5 for
              $5 — and converted before it reaches the API. */}
          <span className="text-sm text-ink">{kind === "PERCENT" ? "Percent" : "Amount"}</span>
          <input
            name="amount"
            type="number"
            min={kind === "PERCENT" ? 1 : 0.01}
            max={kind === "PERCENT" ? 100 : undefined}
            step={kind === "PERCENT" ? 1 : 0.01}
            required
            className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2 text-ink"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="w-40">
          <span className="text-sm text-ink">Minimum spend</span>
          <input
            name="minOrder"
            type="number"
            min={0}
            step={0.01}
            placeholder="0.00"
            className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2 text-ink"
          />
        </label>
        <label className="w-44">
          <span className="text-sm text-ink">Ends</span>
          <input
            name="endsAt"
            type="date"
            className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2 text-ink"
          />
        </label>
        <label className="w-36">
          <span className="text-sm text-ink">Total uses</span>
          <input
            name="maxRedemptions"
            type="number"
            min={1}
            placeholder="Unlimited"
            className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2 text-ink"
          />
        </label>
        <label className="w-40">
          <span className="text-sm text-ink">Per customer</span>
          <input
            name="perCustomerLimit"
            type="number"
            min={1}
            placeholder="Unlimited"
            className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2 text-ink"
          />
        </label>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <Submit />

      {/* Said once, plainly: the per-customer limit is not enforceable against
          someone who never signs in, and an owner should know that before
          relying on it. */}
      <p className="text-xs text-ink-muted">
        Per-customer limits only apply to customers with an account — a guest
        checking out again counts as a new customer.
      </p>
    </form>
  );
}
