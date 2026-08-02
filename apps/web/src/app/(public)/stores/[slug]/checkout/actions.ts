"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ApiError, api } from "@/lib/api";
import type { Quote } from "@/lib/storefront";

export interface CheckoutState {
  quote: Quote | null;
  error: string | null;
  fieldErrors: Record<string, string>;
}

function readAddress(formData: FormData) {
  const line1 = String(formData.get("line1") ?? "").trim();
  if (!line1) return null;

  return {
    line1,
    line2: String(formData.get("line2") ?? "").trim() || null,
    city: String(formData.get("city") ?? "").trim(),
    state: String(formData.get("state") ?? "").trim().toUpperCase(),
    postalCode: String(formData.get("postalCode") ?? "").trim(),
    // Geocoding lands with the delivery phase. Until then the API says plainly
    // that it cannot place the address rather than guessing a zone.
    lat: parseCoord(formData.get("lat")),
    lng: parseCoord(formData.get("lng")),
  };
}

function parseCoord(value: FormDataEntryValue | null): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Re-prices the order as the shopper changes fulfilment, address or tip. */
export async function quoteOrder(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const storeId = String(formData.get("storeId") ?? "");
  const fulfillment = formData.get("fulfillment") === "DELIVERY" ? "DELIVERY" : "PICKUP";

  try {
    const quote = await api<Quote>(`/stores/${storeId}/checkout/quote`, {
      method: "POST",
      body: {
        fulfillment,
        address: fulfillment === "DELIVERY" ? readAddress(formData) : null,
        tipCents: Math.max(0, Math.round(Number(formData.get("tipCents") ?? 0))),
      },
    });
    return { quote, error: null, fieldErrors: {} };
  } catch (err) {
    if (err instanceof ApiError) {
      return { quote: null, error: err.message, fieldErrors: err.fieldErrors };
    }
    throw err;
  }
}

/**
 * Places the order, then sends the shopper to their receipt.
 *
 * The idempotency key comes from the form, minted once when the page rendered,
 * so a double submit or a retry after a dropped response returns the original
 * order instead of placing a second one.
 */
export async function placeOrder(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const storeId = String(formData.get("storeId") ?? "");
  const storeSlug = String(formData.get("storeSlug") ?? "");
  const fulfillment = formData.get("fulfillment") === "DELIVERY" ? "DELIVERY" : "PICKUP";

  let orderId: string;
  try {
    const order = await api<{ id: string; guestToken: string | null }>(`/stores/${storeId}/checkout`, {
      method: "POST",
      body: {
        fulfillment,
        address: fulfillment === "DELIVERY" ? readAddress(formData) : null,
        tipCents: Math.max(0, Math.round(Number(formData.get("tipCents") ?? 0))),
        contactEmail: String(formData.get("contactEmail") ?? "").trim() || null,
        contactPhone: String(formData.get("contactPhone") ?? "").trim() || null,
        customerNote: String(formData.get("customerNote") ?? "").trim() || null,
        idempotencyKey: String(formData.get("idempotencyKey") ?? ""),
      },
    });
    orderId = order.id;

    // The API's own Set-Cookie stops at this server — the browser only ever
    // talks to Next. Without re-issuing it here a guest could place an order
    // and then be unable to open their own receipt.
    if (order.guestToken) {
      const jar = await cookies();
      jar.set(`bba_order_${order.id}`, order.guestToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 90 * 86_400,
        path: "/",
      });
    }
  } catch (err) {
    if (err instanceof ApiError) {
      return { quote: null, error: err.message, fieldErrors: err.fieldErrors };
    }
    throw err;
  }

  revalidatePath(`/stores/${storeSlug}/cart`);
  redirect(`/orders/${orderId}`);
}
