"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ApiError, api } from "@/lib/api";

export interface ConnectState {
  error: string | null;
}

/**
 * Starts or resumes Stripe onboarding, then sends the owner to Stripe.
 *
 * The redirect leaves our site entirely: identity documents and bank details
 * are given to Stripe directly and never touch this platform, which is what
 * keeps us in PCI SAQ-A scope and out of holding anyone's ID.
 */
export async function startStripeOnboarding(
  _prev: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const storeId = String(formData.get("storeId") ?? "");

  let url: string;
  try {
    const result = await api<{ url: string }>(`/stores/${storeId}/payments/connect/onboard`, {
      method: "POST",
    });
    url = result.url;
  } catch (err) {
    return {
      error: err instanceof ApiError ? err.message : "Couldn't start Stripe setup.",
    };
  }

  redirect(url);
}

/** Re-reads the account from Stripe. Pressed after returning from onboarding. */
export async function syncStripeStatus(
  _prev: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const storeId = String(formData.get("storeId") ?? "");

  try {
    await api(`/stores/${storeId}/payments/connect/sync`, { method: "POST" });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : "Couldn't refresh from Stripe." };
  }

  revalidatePath(`/store/${storeId}/ops/settings`);
  return { error: null };
}
