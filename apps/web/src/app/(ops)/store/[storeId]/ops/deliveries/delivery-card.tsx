"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { completeDelivery, failDelivery, pickUpDelivery } from "./actions";
import { ProofCapture } from "./proof-capture";
import { SignaturePad } from "./signature-pad";
import { FAILURE_REASONS, formatAddress, type DeliveryRow } from "./types";

/**
 * One parcel on a driver's round.
 *
 * Sized for a phone held in one hand at the kerb: full-width buttons, one
 * obvious next action, and the address and phone number reachable without
 * opening anything. The failure form is behind a tap because it is the
 * uncommon path — but it is one tap, not a menu.
 */
export function DeliveryCard({ storeId, row }: { storeId: string; row: DeliveryRow }) {
  const router = useRouter();
  const [showFailure, setShowFailure] = useState(false);
  const [reason, setReason] = useState<string>(FAILURE_REASONS[0].value);
  const [note, setNote] = useState("");
  const [proofAssetId, setProofAssetId] = useState<string | null>(null);
  const [signatureAssetId, setSignatureAssetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const outForDelivery = row.order_status === "OUT_FOR_DELIVERY";
  const address = formatAddress(row.delivery_address);

  function act(work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>) {
    setError(null);
    start(async () => {
      const result = await work();
      if (!result.ok) setError(result.error);
      else {
        setShowFailure(false);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4 rounded-card border border-line p-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-medium text-ink">#{row.order_number}</p>
          {row.attempts > 0 && (
            // A second attempt is ordinary; a fourth is a conversation with the
            // customer. Either way the driver should know before setting off.
            <span className="text-sm text-danger">
              {row.attempts === 1 ? "1 failed attempt" : `${row.attempts} failed attempts`}
            </span>
          )}
        </div>
        <p className="text-ink">{address}</p>
        {row.failure_reason && (
          <p className="text-sm text-ink-muted">
            Last time: {labelFor(row.failure_reason)}
            {row.failure_note && ` — ${row.failure_note}`}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        {row.contact_phone && (
          // A tel: link, not text to copy. At the kerb, tapping is the whole
          // interaction.
          <a
            href={`tel:${row.contact_phone.replace(/\s/g, "")}`}
            className="rounded-card border border-line px-4 py-2 font-medium text-ink"
          >
            Call {row.contact_phone}
          </a>
        )}
        {row.delivery_address && (
          <a
            href={`https://maps.apple.com/?q=${encodeURIComponent(address)}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-card border border-line px-4 py-2 font-medium text-ink"
          >
            Directions
          </a>
        )}
      </div>

      {!outForDelivery ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => act(() => pickUpDelivery(storeId, row.order_id))}
          className="w-full rounded-card bg-brand px-5 py-3 text-base font-medium text-brand-ink disabled:opacity-60"
        >
          {pending ? "Saving…" : "I've got it — on my way"}
        </button>
      ) : (
        <div className="space-y-3">
          {/* Above the button, not behind it: the photograph is taken at the
              door and the button is pressed walking away, which is the order
              they appear in here. */}
          {!showFailure && (
            <>
              <ProofCapture storeId={storeId} onCaptured={setProofAssetId} />
              {/* Both are optional and neither blocks the button. A driver
                  standing at a door with no answer and no signature still has
                  to be able to say what happened. */}
              <SignaturePad storeId={storeId} onCaptured={setSignatureAssetId} />
            </>
          )}

          <button
            type="button"
            disabled={pending}
            onClick={() =>
              act(() =>
                completeDelivery(storeId, row.order_id, {
                  proofMediaAssetId: proofAssetId ?? undefined,
                  signatureMediaAssetId: signatureAssetId ?? undefined,
                }),
              )
            }
            className="w-full rounded-card bg-brand px-5 py-3 text-base font-medium text-brand-ink disabled:opacity-60"
          >
            {pending ? "Saving…" : completeLabel(proofAssetId, signatureAssetId)}
          </button>

          {!showFailure ? (
            <button
              type="button"
              onClick={() => setShowFailure(true)}
              className="w-full rounded-card border border-line px-5 py-3 text-base text-ink"
            >
              Couldn&rsquo;t deliver it
            </button>
          ) : (
            <form
              className="space-y-3 rounded-card bg-surface p-4"
              onSubmit={(e) => {
                e.preventDefault();
                act(() => failDelivery(storeId, row.order_id, { reason, note: note || undefined }));
              }}
            >
              <label className="block">
                <span className="text-sm text-ink">What happened?</span>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="mt-1 block w-full rounded-card border border-line px-3 py-2.5 text-base text-ink"
                >
                  {FAILURE_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-ink">Anything to add? (optional)</span>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="mt-1 block w-full rounded-card border border-line px-3 py-2.5 text-base text-ink"
                />
              </label>
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={pending}
                  className="flex-1 rounded-card bg-brand px-5 py-3 text-base font-medium text-brand-ink disabled:opacity-60"
                >
                  {pending ? "Saving…" : "Bringing it back"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowFailure(false)}
                  className="rounded-card border border-line px-5 py-3 text-base text-ink"
                >
                  Cancel
                </button>
              </div>
              <p className="text-sm text-ink-muted">
                The order goes back to ready, so somebody can take it out again.
              </p>
            </form>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Names what is about to be filed alongside the delivery.
 *
 * The button says what it will record, so the driver can see at a glance that
 * the signature they just watched somebody write did in fact save — without
 * scrolling back up to check.
 */
function completeLabel(proof: string | null, signature: string | null): string {
  if (proof && signature) return "Delivered — with photo and signature";
  if (proof) return "Delivered — with photo";
  if (signature) return "Delivered — with signature";
  return "Delivered";
}

function labelFor(reason: string): string {
  return FAILURE_REASONS.find((r) => r.value === reason)?.label ?? reason.toLowerCase();
}
