"use server";

import { ApiError, api } from "@/lib/api";

export interface PayState {
  clientSecret: string | null;
  publishableKey: string | null;
  amountCents: number | null;
  error: string | null;
}

/**
 * Creates the card payment for an order and hands back the client secret.
 *
 * Done on demand rather than when the order is placed: most orders in the
 * pilot are paid in cash, and creating a PaymentIntent for every one of them
 * would litter the store's Stripe dashboard with abandoned intents.
 */
export async function startCardPayment(
  _prev: PayState,
  formData: FormData,
): Promise<PayState> {
  const storeId = String(formData.get("storeId") ?? "");
  const orderId = String(formData.get("orderId") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");

  try {
    const result = await api<{
      clientSecret: string;
      amountCents: number;
      publishableKey: string | null;
    }>(`/stores/${storeId}/payments/orders/${orderId}/card`, {
      method: "POST",
      body: { idempotencyKey },
    });

    if (!result.publishableKey) {
      return {
        clientSecret: null,
        publishableKey: null,
        amountCents: null,
        error: "Card payments aren't available right now.",
      };
    }

    return {
      clientSecret: result.clientSecret,
      publishableKey: result.publishableKey,
      amountCents: result.amountCents,
      error: null,
    };
  } catch (err) {
    return {
      clientSecret: null,
      publishableKey: null,
      amountCents: null,
      error: err instanceof ApiError ? err.message : "Couldn't start that payment.",
    };
  }
}
