"use server";

import { revalidatePath } from "next/cache";
import { ApiError, api } from "@/lib/api";

export type ActionResult = { ok: true } | { ok: false; error: string };

async function run(work: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await work();
    // Both the page and the badge that sits above it.
    revalidatePath("/notifications");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : "That didn't work." };
  }
}

export async function markRead(notificationId: string): Promise<ActionResult> {
  return run(() => api(`/me/notifications/${notificationId}/read`, { method: "POST" }));
}

export async function markAllRead(): Promise<ActionResult> {
  return run(() => api("/me/notifications/read", { method: "POST" }));
}

export async function setPreference(input: {
  event: string;
  channel: string;
  storeId?: string | null;
  enabled: boolean;
}): Promise<ActionResult> {
  return run(() => api("/me/notifications", { method: "PUT", body: input }));
}
