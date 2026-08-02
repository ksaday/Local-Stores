"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { startStripeOnboarding, syncStripeStatus, type ConnectState } from "./payments-actions";

const EMPTY: ConnectState = { error: null };

export interface ConnectStatus {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
  syncedAt: string | null;
}

/**
 * Turns Stripe's requirement codes into something a shop owner can act on.
 *
 * Left as the raw code when unmapped rather than hidden: a code the owner can
 * search for beats "additional information required", which tells them nothing
 * and leaves them ringing support.
 */
const REQUIREMENT_LABELS: Record<string, string> = {
  "external_account": "Add the bank account you want to be paid into",
  "individual.verification.document": "Upload a photo ID",
  "individual.id_number": "Provide your ID or Social Security number",
  "individual.address.line1": "Confirm your address",
  "business_profile.url": "Add your website or storefront link",
  "business_profile.mcc": "Say what kind of business you run",
  "tos_acceptance.date": "Accept Stripe's terms of service",
};

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

export function StripeConnect({
  storeId,
  status,
}: {
  storeId: string;
  status: ConnectStatus;
}) {
  const [onboardState, runOnboard] = useActionState(startStripeOnboarding, EMPTY);
  const [syncState, runSync] = useActionState(syncStripeStatus, EMPTY);
  const error = onboardState.error ?? syncState.error;

  const notStarted = !status.accountId;
  const ready = status.chargesEnabled;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${
            ready
              ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
              : notStarted
                ? "bg-neutral-100 text-neutral-700 ring-neutral-300"
                : "bg-amber-50 text-amber-800 ring-amber-200"
          }`}
        >
          {ready ? "Card payments on" : notStarted ? "Not set up" : "Setup unfinished"}
        </span>

        {ready && !status.payoutsEnabled && (
          // Being able to charge but not be paid out is a real and confusing
          // state — the money is accumulating at Stripe rather than arriving.
          <span className="text-sm text-amber-700">
            Taking payments, but payouts to your bank are on hold.
          </span>
        )}
      </div>

      {ready ? (
        <p className="text-sm text-ink-muted">
          Customers can pay by card on your storefront. Money goes straight to your
          own Stripe account — we never take a cut of a sale.
        </p>
      ) : (
        <p className="text-sm text-ink-muted">
          {notStarted
            ? "Connect Stripe to take card payments online. You'll set it up on Stripe's own site — we never see your bank details or ID."
            : "Stripe still needs a few things from you before you can take cards."}
        </p>
      )}

      {status.requirementsDue.length > 0 && (
        <ul className="space-y-1 rounded-card border border-line bg-surface-muted p-4 text-sm text-ink">
          {status.requirementsDue.map((code) => (
            <li key={code}>• {REQUIREMENT_LABELS[code] ?? code}</li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <form action={runOnboard}>
          <input type="hidden" name="storeId" value={storeId} />
          <Submit
            label={notStarted ? "Connect Stripe" : ready ? "Manage on Stripe" : "Finish Stripe setup"}
            pending="Opening Stripe…"
          />
        </form>

        {!notStarted && (
          <form action={runSync}>
            <input type="hidden" name="storeId" value={storeId} />
            <button
              type="submit"
              className="rounded-card border border-line px-5 py-2.5 text-sm font-medium text-ink"
            >
              Refresh status
            </button>
          </form>
        )}
      </div>

      {/* Cash never depended on Stripe, and an owner mid-setup should not think
          their shop has stopped working. */}
      <p className="text-sm text-ink-muted">
        Cash payments work regardless of whether Stripe is connected.
      </p>
    </div>
  );
}
