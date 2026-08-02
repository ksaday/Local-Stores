"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ApiError, api } from "@/lib/api";

export interface BillingActionState {
  error: string | null;
}

/** Starts the subscription, trial included. No card is asked for. */
export async function startSubscription(
  _prev: BillingActionState,
  formData: FormData,
): Promise<BillingActionState> {
  const storeId = String(formData.get("storeId") ?? "");

  try {
    await api(`/stores/${storeId}/billing/subscribe`, { method: "POST" });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : "Couldn't start your subscription." };
  }

  revalidatePath(`/store/${storeId}/ops/settings`);
  return { error: null };
}

/**
 * Sends the owner to Stripe's hosted billing portal.
 *
 * Card details, invoices and cancellation all live there — this platform never
 * sees a subscription card any more than it sees a shopper's.
 */
export async function openBillingPortal(
  _prev: BillingActionState,
  formData: FormData,
): Promise<BillingActionState> {
  const storeId = String(formData.get("storeId") ?? "");

  let url: string;
  try {
    const result = await api<{ url: string }>(`/stores/${storeId}/billing/portal`, { method: "POST" });
    url = result.url;
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : "Couldn't open the billing portal." };
  }

  redirect(url);
}
