"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { refundOrder, type OrderActionState } from "../actions";

const EMPTY: OrderActionState = { error: null };

const REASONS = [
  { value: "", label: "No reason given" },
  { value: "customer_request", label: "Customer asked" },
  { value: "damaged", label: "Damaged or wrong" },
  { value: "duplicate", label: "Duplicate charge" },
  { value: "fraud", label: "Fraudulent" },
];

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        // Money leaving the shop is not undoable from this screen.
        if (!window.confirm("Refund this payment? This can't be undone here.")) {
          e.preventDefault();
        }
      }}
      className="min-h-11 rounded-card border border-danger/40 px-4 py-2.5 text-sm font-medium text-danger disabled:opacity-60"
    >
      {pending ? "Refunding…" : "Refund"}
    </button>
  );
}

export function RefundPanel({
  storeId,
  orderId,
  maxCents,
  currency,
  refunds,
}: {
  storeId: string;
  orderId: string;
  maxCents: number;
  currency: string;
  refunds: { id: string; amountCents: number; status: string; createdAt: string }[];
}) {
  const [state, run] = useActionState(refundOrder, EMPTY);
  const [open, setOpen] = useState(false);

  const money = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

  // Failed attempts never moved money, so they must not count against what is
  // still refundable.
  const refunded = refunds
    .filter((r) => r.status !== "FAILED")
    .reduce((sum, r) => sum + r.amountCents, 0);
  const remaining = maxCents - refunded;

  return (
    <div className="space-y-3">
      {refunds.length > 0 && (
        <ul className="space-y-1 text-sm">
          {refunds.map((refund) => (
            <li key={refund.id} className="flex items-center justify-between">
              <span className="text-ink">
                {money(refund.amountCents)} refunded
                {refund.status === "PENDING" && " — awaiting Stripe"}
                {refund.status === "FAILED" && " — failed"}
              </span>
              <time dateTime={refund.createdAt} className="text-ink-muted">
                {new Date(refund.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </time>
            </li>
          ))}
        </ul>
      )}

      {remaining <= 0 ? (
        <p className="text-sm text-ink-muted">Fully refunded.</p>
      ) : !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm text-danger underline underline-offset-4"
        >
          Refund {refunded > 0 ? `up to ${money(remaining)}` : "this payment"}
        </button>
      ) : (
        <form action={run} className="space-y-3 rounded-card border border-line p-4">
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="orderId" value={orderId} />

          <label className="block">
            <span className="text-sm text-ink">Amount in cents</span>
            <input
              name="amountCents"
              type="number"
              min={1}
              max={remaining}
              placeholder={String(remaining)}
              className="mt-1 w-36 rounded-card border border-line bg-surface px-3 py-2 text-ink"
            />
            <span className="ml-2 text-sm text-ink-muted">
              Leave blank to refund all {money(remaining)}
            </span>
          </label>

          <label className="block">
            <span className="text-sm text-ink">Reason</span>
            <select
              name="reasonCode"
              className="mt-1 block rounded-card border border-line bg-surface px-3 py-2 text-ink"
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm text-ink">Note (for your records)</span>
            <input
              name="note"
              maxLength={500}
              className="mt-1 w-full rounded-card border border-line bg-surface px-3 py-2 text-ink"
            />
          </label>

          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}

          <div className="flex gap-3">
            <Submit />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm text-ink-muted"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
