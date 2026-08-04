"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignDriver, unassignDriver } from "./actions";
import { formatAddress, type DeliveryRow, type Driver } from "./types";

/**
 * One parcel on the dispatch board.
 *
 * Assigning is a select and nothing else — no confirm step. Putting a parcel on
 * the wrong round costs one more tap to fix, and a dispatcher doing twenty of
 * these in a morning should not confirm twenty times.
 */
export function DispatchRow({
  storeId,
  row,
  drivers,
}: {
  storeId: string;
  row: DeliveryRow;
  drivers: Driver[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function act(work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>) {
    setError(null);
    start(async () => {
      const result = await work();
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">
            #{row.order_number}
            {row.order_status === "OUT_FOR_DELIVERY" && (
              <span className="ml-2 font-normal text-ink-muted">on the road</span>
            )}
          </p>
          <p className="text-sm text-ink-muted">{formatAddress(row.delivery_address)}</p>
          {row.attempts > 0 && (
            <p className="text-sm text-danger">
              {row.attempts === 1 ? "1 failed attempt" : `${row.attempts} failed attempts`}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <select
            value={row.driver_user_id ?? ""}
            disabled={pending || drivers.length === 0}
            onChange={(e) =>
              act(() =>
                e.target.value
                  ? assignDriver(storeId, row.order_id, e.target.value)
                  : unassignDriver(storeId, row.order_id),
              )
            }
            className="rounded-card border border-line px-3 py-2 text-sm text-ink disabled:opacity-60"
          >
            <option value="">Nobody yet</option>
            {drivers.map((d) => (
              <option key={d.userId} value={d.userId}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {drivers.length === 0 && (
        <p className="text-sm text-ink-muted">
          Nobody at this shop has a delivery role yet — add one under Team.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
