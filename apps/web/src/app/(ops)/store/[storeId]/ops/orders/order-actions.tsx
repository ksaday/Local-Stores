"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { OrderStatus } from "@bba/shared";
import { collectCash, transitionOrder, type OrderActionState } from "./actions";

const EMPTY: OrderActionState = { error: null };

const TONE_CLASSES = {
  // Deliberately large: this is tapped on a tablet, often one-handed, by
  // someone who is also holding a bag of bread.
  primary: "bg-brand text-brand-ink",
  neutral: "border border-line text-ink",
  danger: "border border-danger/40 text-danger",
} as const;

function ActionButton({
  label,
  tone,
  confirm,
}: {
  label: string;
  tone: keyof typeof TONE_CLASSES;
  confirm?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      // Cancelling and refunding are not undoable through this screen, so they
      // ask first. Advancing an order is cheap to correct, so it does not.
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
      className={`min-h-11 rounded-card px-4 py-2.5 text-sm font-medium disabled:opacity-60 ${TONE_CLASSES[tone]}`}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

/**
 * The status actions for one order.
 *
 * Only transitions the caller's role owns are passed in — the queue derives
 * them from the same state machine the API enforces, so a button that appears
 * here will not be refused by the server.
 */
export function OrderActions({
  storeId,
  orderId,
  actions,
  compact = false,
}: {
  storeId: string;
  orderId: string;
  actions: { to: OrderStatus; label: string; tone: "primary" | "neutral" | "danger" }[];
  compact?: boolean;
}) {
  const [state, run] = useActionState(transitionOrder, EMPTY);

  if (actions.length === 0) {
    return compact ? null : <p className="text-sm text-ink-muted">Nothing left to do on this order.</p>;
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <form key={action.to} action={run}>
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="orderId" value={orderId} />
            <input type="hidden" name="status" value={action.to} />
            <ActionButton
              label={action.label}
              tone={action.tone}
              confirm={
                action.tone === "danger"
                  ? `${action.label} this order? This can't be undone here.`
                  : undefined
              }
            />
          </form>
        ))}
      </div>
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {state.error}
        </p>
      )}
    </div>
  );
}

export function CollectCashButton({
  storeId,
  orderId,
  amountLabel,
}: {
  storeId: string;
  orderId: string;
  amountLabel: string;
}) {
  const [state, run] = useActionState(collectCash, EMPTY);

  return (
    <div>
      <form action={run}>
        <input type="hidden" name="storeId" value={storeId} />
        <input type="hidden" name="orderId" value={orderId} />
        <ActionButton label={`Take ${amountLabel} cash`} tone="primary" />
      </form>
      {state.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {state.error}
        </p>
      )}
    </div>
  );
}
