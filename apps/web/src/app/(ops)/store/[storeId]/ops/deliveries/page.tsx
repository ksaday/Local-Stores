import type { Metadata } from "next";
import { Card, EmptyState } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import type { StaffMember } from "@/lib/types";
import { DeliveryCard } from "./delivery-card";
import { DispatchRow } from "./dispatch-row";
import type { DeliveryRow, Driver } from "./types";

export const metadata: Metadata = { title: "Deliveries" };
export const dynamic = "force-dynamic";

/**
 * Reads a list the caller may not be allowed to see.
 *
 * A driver holds `delivery:read-own` and not `read-all`, so the dispatch board
 * is a 403 for them — which is the correct answer, not an error worth showing.
 * Anything else is a real failure and is left to throw.
 */
async function readIfPermitted<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

export default async function DeliveriesPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  const [mine, board, staff] = await Promise.all([
    readIfPermitted(() =>
      api<DeliveryRow[]>(`/stores/${storeId}/deliveries/mine`, { revalidate: false }),
    ),
    readIfPermitted(() =>
      api<DeliveryRow[]>(`/stores/${storeId}/deliveries`, { revalidate: false }),
    ),
    readIfPermitted(() =>
      api<StaffMember[]>(`/stores/${storeId}/members`, { revalidate: false }),
    ),
  ]);

  const drivers: Driver[] = (staff ?? [])
    .filter((m) => m.status === "ACTIVE" && (m.role === "DELIVERY" || m.role === "STORE_ADMIN"))
    .map((m) => ({ userId: m.userId, name: m.name }));

  // Everything on the board that is not already on this driver's round — a
  // dispatcher does not need to see the same parcel in two lists.
  const mineIds = new Set((mine ?? []).map((d) => d.order_id));
  const unassignedOrOthers = (board ?? []).filter((d) => !mineIds.has(d.order_id));

  return (
    <div className="mt-8 space-y-6">
      {mine && (
        <Card
          title="Your round"
          description={
            mine.length === 0
              ? "Nothing assigned to you right now."
              : `${mine.length} ${mine.length === 1 ? "parcel" : "parcels"} to deliver.`
          }
        >
          {mine.length === 0 ? (
            <EmptyState
              title="Nothing to take out"
              hint="Parcels appear here once somebody assigns them to you."
            />
          ) : (
            <ul className="space-y-4">
              {mine.map((row) => (
                <li key={row.id}>
                  <DeliveryCard storeId={storeId} row={row} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {board && (
        <Card
          title="Dispatch"
          description="Everything still to go out, oldest first."
        >
          {unassignedOrOthers.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              hint="Delivery orders appear here once they are ready to leave."
            />
          ) : (
            <ul className="divide-y divide-line">
              {unassignedOrOthers.map((row) => (
                <li key={row.id} className="py-4">
                  <DispatchRow storeId={storeId} row={row} drivers={drivers} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {!mine && !board && (
        <Card title="Deliveries">
          <EmptyState
            title="Nothing here for you"
            hint="You need a delivery role at this shop to see rounds or dispatch."
          />
        </Card>
      )}
    </div>
  );
}
