"use server";

import { revalidatePath } from "next/cache";
import { ApiError, api } from "@/lib/api";

export interface CouponActionState {
  error: string | null;
}

/**
 * Creates a coupon.
 *
 * The form collects a percentage or a dollar amount, because that is how an
 * owner thinks about a discount; the conversion to basis points or cents
 * happens here rather than asking anyone to enter "1000" for 10%.
 */
export async function createCoupon(
  _prev: CouponActionState,
  formData: FormData,
): Promise<CouponActionState> {
  const storeId = String(formData.get("storeId") ?? "");
  const kind = formData.get("kind") === "PERCENT" ? "PERCENT" : "FIXED";
  const amount = Number(formData.get("amount") ?? 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Enter a discount greater than zero." };
  }
  if (kind === "PERCENT" && amount > 100) {
    return { error: "A percentage discount can't be more than 100%." };
  }

  const minOrder = Number(formData.get("minOrder") ?? 0);
  const endsAt = String(formData.get("endsAt") ?? "").trim();
  const maxRedemptions = String(formData.get("maxRedemptions") ?? "").trim();
  const perCustomerLimit = String(formData.get("perCustomerLimit") ?? "").trim();

  try {
    await api(`/stores/${storeId}/coupons`, {
      method: "POST",
      body: {
        code: String(formData.get("code") ?? ""),
        kind,
        // Basis points for a percentage, cents for a fixed amount.
        value: kind === "PERCENT" ? Math.round(amount * 100) : Math.round(amount * 100),
        minOrderCents: Number.isFinite(minOrder) ? Math.round(minOrder * 100) : 0,
        ...(endsAt ? { endsAt: new Date(endsAt).toISOString() } : {}),
        ...(maxRedemptions ? { maxRedemptions: Number(maxRedemptions) } : {}),
        ...(perCustomerLimit ? { perCustomerLimit: Number(perCustomerLimit) } : {}),
      },
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : "Couldn't create that coupon." };
  }

  revalidatePath(`/store/${storeId}/ops/coupons`);
  return { error: null };
}

/** Switches a coupon on or off without deleting it. */
export async function toggleCoupon(formData: FormData): Promise<void> {
  const storeId = String(formData.get("storeId") ?? "");
  const couponId = String(formData.get("couponId") ?? "");
  const active = formData.get("active") === "true";

  await api(`/stores/${storeId}/coupons/${couponId}`, {
    method: "PATCH",
    body: { active },
  });
  revalidatePath(`/store/${storeId}/ops/coupons`);
}

export async function deleteCoupon(formData: FormData): Promise<void> {
  const storeId = String(formData.get("storeId") ?? "");
  const couponId = String(formData.get("couponId") ?? "");

  await api(`/stores/${storeId}/coupons/${couponId}`, { method: "DELETE" });
  revalidatePath(`/store/${storeId}/ops/coupons`);
}
