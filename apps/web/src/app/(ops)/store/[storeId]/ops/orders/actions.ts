"use server";

import { revalidatePath } from "next/cache";
import { ApiError, api } from "@/lib/api";

export interface OrderActionState {
  error: string | null;
}

/**
 * Moves an order to a new status.
 *
 * The API re-checks both the transition and the caller's role, so this is a
 * thin pass-through — the point of doing it here is that the queue revalidates
 * and the clerk sees the result without reloading.
 */
export async function transitionOrder(
  _prev: OrderActionState,
  formData: FormData,
): Promise<OrderActionState> {
  const storeId = String(formData.get("storeId") ?? "");
  const orderId = String(formData.get("orderId") ?? "");
  const status = String(formData.get("status") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  try {
    await api(`/stores/${storeId}/orders/${orderId}/status`, {
      method: "POST",
      body: { status, ...(note ? { note } : {}) },
    });
  } catch (err) {
    // The API's message explains *why* — "this order is ready, it can't be
    // marked preparing" — which is more use to a clerk than "failed".
    return { error: err instanceof ApiError ? err.message : "Couldn't update that order." };
  }

  revalidatePath(`/store/${storeId}/ops/orders`);
  revalidatePath(`/store/${storeId}/ops/orders/${orderId}`);
  return { error: null };
}

/** Records that cash has been taken for an order. */
export async function collectCash(
  _prev: OrderActionState,
  formData: FormData,
): Promise<OrderActionState> {
  const storeId = String(formData.get("storeId") ?? "");
  const orderId = String(formData.get("orderId") ?? "");

  try {
    await api(`/stores/${storeId}/orders/${orderId}/payment/cash`, { method: "POST" });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : "Couldn't record that payment." };
  }

  revalidatePath(`/store/${storeId}/ops/orders/${orderId}`);
  return { error: null };
}
