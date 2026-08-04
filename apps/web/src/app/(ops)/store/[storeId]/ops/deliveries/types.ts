/** Mirrors the API's delivery row. Own module: route files may not export these. */
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
}

export interface Driver {
  userId: string;
  name: string;
}

/** Why a delivery didn't happen, in the order a driver scans them. */
export const FAILURE_REASONS = [
  { value: "NOBODY_HOME", label: "Nobody home" },
  { value: "ADDRESS_NOT_FOUND", label: "Couldn't find the address" },
  { value: "REFUSED", label: "Customer refused it" },
  { value: "UNSAFE_TO_LEAVE", label: "Nowhere safe to leave it" },
  { value: "VEHICLE_PROBLEM", label: "Vehicle problem" },
  { value: "OTHER", label: "Something else" },
] as const;

/** One line of an address, for a driver reading it at a junction. */
export function formatAddress(address: DeliveryRow["delivery_address"]): string {
  if (!address) return "No address on the order";
  return [address.line1, address.line2, address.city, address.postalCode]
    .filter(Boolean)
    .join(", ");
}
