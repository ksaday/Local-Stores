"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { ApiError, api } from "@/lib/api";

const CART_COOKIE = "bba_cart";
const CART_MAX_AGE_S = 30 * 86_400;

/**
 * Ensures a guest cart key exists before the API is called.
 *
 * The BFF is why this lives here rather than in the API: the browser talks to
 * Next, Next talks to the API, and a `Set-Cookie` on the API's response never
 * reaches the browser. So Next owns the cookie and forwards it as an identity.
 *
 * Signed-in shoppers need none of this — their cart hangs off their account,
 * which is what lets it follow them to another device.
 */
async function ensureCartKey(): Promise<void> {
  const jar = await cookies();
  if (jar.get("bba_at") || jar.get(CART_COOKIE)) return;

  jar.set(CART_COOKIE, randomBytes(24).toString("base64url"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: CART_MAX_AGE_S,
    path: "/",
  });
}

export interface CartActionState {
  error: string | null;
}

export async function addToCart(
  _prev: CartActionState,
  formData: FormData,
): Promise<CartActionState> {
  const storeId = String(formData.get("storeId") ?? "");
  const storeSlug = String(formData.get("storeSlug") ?? "");
  const variantId = String(formData.get("variantId") ?? "");
  const qty = Number(formData.get("qty") ?? 1);

  await ensureCartKey();

  try {
    await api(`/stores/${storeId}/cart/items`, {
      method: "POST",
      body: { variantId, qty: Number.isFinite(qty) && qty > 0 ? qty : 1 },
    });
  } catch (err) {
    // The message is the store's own ("that item isn't for sale"), which is
    // more useful than a generic failure.
    return { error: err instanceof ApiError ? err.message : "Couldn't add that to your cart." };
  }

  revalidatePath(`/stores/${storeSlug}`, "layout");
  redirect(`/stores/${storeSlug}/cart`);
}

export async function updateCartItem(formData: FormData): Promise<void> {
  const storeId = String(formData.get("storeId") ?? "");
  const storeSlug = String(formData.get("storeSlug") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  const qty = Number(formData.get("qty") ?? 0);

  await api(`/stores/${storeId}/cart/items/${itemId}`, {
    method: "PATCH",
    body: { qty: Number.isFinite(qty) ? Math.max(0, Math.trunc(qty)) : 0 },
  });

  revalidatePath(`/stores/${storeSlug}/cart`);
}

export async function removeCartItem(formData: FormData): Promise<void> {
  const storeId = String(formData.get("storeId") ?? "");
  const storeSlug = String(formData.get("storeSlug") ?? "");
  const itemId = String(formData.get("itemId") ?? "");

  await api(`/stores/${storeId}/cart/items/${itemId}`, { method: "DELETE" });
  revalidatePath(`/stores/${storeSlug}/cart`);
}
