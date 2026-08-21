import { Card } from "@/components/shell";
import type { DeliveryRow } from "@/lib/delivery";

const FAILURE_LABELS: Record<string, string> = {
  NOBODY_HOME: "Nobody home",
  ADDRESS_NOT_FOUND: "Couldn't find the address",
  REFUSED: "Customer refused it",
  UNSAFE_TO_LEAVE: "Nowhere safe to leave it",
  VEHICLE_PROBLEM: "Vehicle problem",
  OTHER: "Something else",
};

function at(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * What happened to the parcel, for whoever is fielding "it never arrived".
 *
 * The photograph is the reason this panel exists — it is the one piece of the
 * record that answers the question rather than describing it — so it is shown
 * rather than linked, at a size somebody can actually recognise a doorway in.
 *
 * The URL behind it expires in minutes, which is why nothing here caches: the
 * page is `force-dynamic`, so the URL is minted when the page is read.
 */
export function DeliveryPanel({ delivery }: { delivery: DeliveryRow }) {
  const { driver_name, picked_up_at, delivered_at, failure_reason, attempts } = delivery;

  return (
    <Card title="Delivery">
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">Driver</dt>
          <dd className="text-ink">{driver_name ?? "Not assigned yet"}</dd>
        </div>
        {picked_up_at && (
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">Left the shop</dt>
            <dd className="text-ink">{at(picked_up_at)}</dd>
          </div>
        )}
        {delivered_at && (
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">Handed over</dt>
            <dd className="text-ink">{at(delivered_at)}</dd>
          </div>
        )}
        {attempts > 0 && (
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">Attempts</dt>
            <dd className="text-ink">
              {attempts === 1 ? "1 that failed" : `${attempts} that failed`}
              {failure_reason && ` — ${FAILURE_LABELS[failure_reason] ?? failure_reason}`}
            </dd>
          </div>
        )}
      </dl>

      {delivery.failure_note && (
        <p className="mt-3 text-sm text-ink-muted">
          Driver&rsquo;s note: {delivery.failure_note}
        </p>
      )}

      {delivery.proof_url ? (
        <figure className="mt-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- a signed,
              expiring URL, which next/image would try to cache and re-serve. */}
          <img
            src={delivery.proof_url}
            alt="Photo the driver took when they left the parcel"
            className="w-full rounded-card"
          />
          <figcaption className="mt-2 text-sm text-ink-muted">
            Taken by the driver when they left it.
          </figcaption>
        </figure>
      ) : (
        delivered_at && <p className="mt-4 text-sm text-ink-muted">No photo was taken.</p>
      )}

      {delivery.signature_url ? (
        <figure className="mt-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- same signed,
              expiring URL as the photo above. */}
          <img
            src={delivery.signature_url}
            alt="Signature the customer wrote when they took delivery"
            // A white sheet on a white card needs its edge drawn, or it reads
            // as a gap in the page rather than as the signature.
            className="w-full rounded-card border border-line bg-white"
          />
          <figcaption className="mt-2 text-sm text-ink-muted">
            Signed for on the doorstep.
          </figcaption>
        </figure>
      ) : (
        delivered_at && <p className="mt-2 text-sm text-ink-muted">Nobody signed for it.</p>
      )}
    </Card>
  );
}
