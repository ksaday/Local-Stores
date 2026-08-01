"use server";

import { revalidatePath } from "next/cache";
import { api, ApiError } from "@/lib/api";

export type ActionResult =
  | { ok: true }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

function toResult(err: unknown): ActionResult {
  if (err instanceof ApiError) {
    const fieldErrors = err.fieldErrors;
    return {
      ok: false,
      message: err.problem.detail || err.problem.title,
      ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    };
  }
  return { ok: false, message: "Something went wrong. Please try again." };
}

export async function updateProfile(
  storeId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const body: Record<string, unknown> = {};
  for (const key of ["name", "legalName", "addressLine1", "city", "state", "postalCode"]) {
    const value = String(formData.get(key) ?? "").trim();
    if (value) body[key] = value;
  }

  const theme = {
    primary: String(formData.get("primary") ?? "").trim(),
    background: String(formData.get("background") ?? "").trim(),
    text: String(formData.get("text") ?? "").trim(),
    accent: String(formData.get("accent") ?? "").trim(),
  };
  if (Object.values(theme).every(Boolean)) body.branding = { theme };

  try {
    await api(`/stores/${storeId}`, { method: "PATCH", body });
  } catch (err) {
    return toResult(err);
  }
  revalidatePath(`/store/${storeId}/ops/settings`);
  return { ok: true };
}

export async function createTaxRate(
  storeId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Owners think in percent; the API stores basis points so a rate like 10.25%
  // survives without floating-point drift.
  const percent = Number(formData.get("percent"));
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { ok: false, message: "Enter a rate between 0 and 100." };
  }

  try {
    await api(`/stores/${storeId}/tax-rates`, {
      method: "POST",
      body: {
        name: String(formData.get("name") ?? "").trim(),
        rateBps: Math.round(percent * 100),
        isDefault: formData.get("isDefault") === "on",
      },
    });
  } catch (err) {
    return toResult(err);
  }
  revalidatePath(`/store/${storeId}/ops/settings`);
  return { ok: true };
}

export async function createZone(
  storeId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const miles = Number(formData.get("radiusMiles"));
  const fee = Number(formData.get("feeDollars"));
  const eta = Number(formData.get("etaMinutes"));
  const lat = Number(formData.get("centerLat"));
  const lng = Number(formData.get("centerLng"));

  if (![miles, fee, eta, lat, lng].every(Number.isFinite)) {
    return { ok: false, message: "Fill in every field with a number." };
  }

  try {
    await api(`/stores/${storeId}/delivery-zones`, {
      method: "POST",
      body: {
        name: String(formData.get("name") ?? "").trim(),
        centerLat: lat,
        centerLng: lng,
        // Owners think in miles; the API takes metres and rejects anything
        // over 100 km, which is what catches a units mistake.
        radiusMeters: Math.round(miles * 1609.34),
        feeCents: Math.round(fee * 100),
        minOrderCents: Math.round(Number(formData.get("minOrderDollars") ?? 0) * 100),
        etaMinutes: eta,
      },
    });
  } catch (err) {
    return toResult(err);
  }
  revalidatePath(`/store/${storeId}/ops/settings`);
  return { ok: true };
}

export async function inviteStaff(
  storeId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await api(`/stores/${storeId}/members/invitations`, {
      method: "POST",
      body: {
        email: String(formData.get("email") ?? "").trim(),
        role: String(formData.get("role") ?? "CLERK"),
      },
    });
  } catch (err) {
    return toResult(err);
  }
  revalidatePath(`/store/${storeId}/ops/staff`);
  return { ok: true };
}

export async function changeStaffRole(
  storeId: string,
  membershipId: string,
  role: string,
): Promise<ActionResult> {
  try {
    await api(`/stores/${storeId}/members/${membershipId}/role`, {
      method: "PATCH",
      body: { role },
    });
  } catch (err) {
    return toResult(err);
  }
  revalidatePath(`/store/${storeId}/ops/staff`);
  return { ok: true };
}

export async function changeStaffStatus(
  storeId: string,
  membershipId: string,
  status: string,
): Promise<ActionResult> {
  try {
    await api(`/stores/${storeId}/members/${membershipId}/status`, {
      method: "PATCH",
      body: { status },
    });
  } catch (err) {
    return toResult(err);
  }
  revalidatePath(`/store/${storeId}/ops/staff`);
  return { ok: true };
}
