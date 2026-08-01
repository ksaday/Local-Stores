"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";

/**
 * Mutations run as Server Actions rather than through the BFF proxy.
 *
 * The proxy is an allowlist limited to auth endpoints on purpose — widening it
 * would hand the browser a session-attached path to any API route. Server
 * Actions keep the call server-side, where the cookie is already available and
 * nothing new is exposed to the client (plan §11.3).
 */

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

export async function approveApplication(
  applicationId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const note = String(formData.get("note") ?? "").trim();

  try {
    await api(`/platform/applications/${applicationId}/approve`, {
      method: "POST",
      body: { slug, ...(note ? { note } : {}) },
    });
  } catch (err) {
    return toResult(err);
  }

  revalidatePath("/platform");
  revalidatePath("/platform/applications");
  redirect("/platform/stores");
}

export async function rejectApplication(
  applicationId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const note = String(formData.get("note") ?? "").trim();
  if (!note) {
    return { ok: false, message: "Give a reason — the applicant sees this." };
  }

  try {
    await api(`/platform/applications/${applicationId}/reject`, {
      method: "POST",
      body: { note },
    });
  } catch (err) {
    return toResult(err);
  }

  revalidatePath("/platform");
  revalidatePath("/platform/applications");
  redirect("/platform/applications");
}

export async function transitionStore(
  storeId: string,
  to: "ACTIVE" | "SUSPENDED" | "CLOSED",
  reason: string,
): Promise<ActionResult> {
  try {
    await api(`/platform/stores/${storeId}/transition`, {
      method: "POST",
      body: { to, ...(reason ? { reason } : {}) },
    });
  } catch (err) {
    return toResult(err);
  }

  revalidatePath("/platform/stores");
  return { ok: true };
}
