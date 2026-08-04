import { ApiError, api } from "./api";

/** Mirrors the API's delivery row. */
export interface DeliveryRow {
  id: string;
  order_id: string;
  order_number: string;
  order_status: string;
  contact_phone: string | null;
  contact_email: string | null;
  delivery_address: { line1?: string; line2?: string; city?: string; postalCode?: string } | null;
  driver_user_id: string | null;
  driver_name: string | null;
  assigned_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  failure_reason: string | null;
  failure_note: string | null;
  attempts: number;
  notes: string | null;
  /** Signed and short-lived — minted per read, so never cached or stored. */
  proof_url: string | null;
  signature_url: string | null;
}

/**
 * One order's delivery, or null when there isn't one to show.
 *
 * Absent is the ordinary case, not a failure: a collection order never has a
 * delivery, and a delivery order gets its record the first time somebody looks
 * at the dispatch board. The order page asks on every order and shows the
 * section only when there is something in it.
 */
export async function loadDelivery(
  storeId: string,
  orderId: string,
): Promise<DeliveryRow | null> {
  try {
    return await api<DeliveryRow>(`/stores/${storeId}/deliveries/${orderId}`, {
      revalidate: false,
    });
  } catch (err) {
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) return null;
    throw err;
  }
}
