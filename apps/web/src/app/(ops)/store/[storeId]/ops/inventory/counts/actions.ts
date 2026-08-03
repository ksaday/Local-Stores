"use server";

import { ApiError, api } from "@/lib/api";
import type { CountLine, CountSession } from "./types";

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * No `revalidatePath` anywhere in here, deliberately.
 *
 * Both this page and the stock screen are `force-dynamic` and fetch with
 * `revalidate: false`, so there is no cache entry for it to clear — and
 * `revalidatePath` also drops the *client* router cache wholesale, which
 * re-renders the workspace and takes the just-posted summary with it. The
 * person lands back on "start a count" having never seen what the one they
 * finished actually did. Components ask for a re-render themselves, when they
 * want one.
 */
async function run<T>(storeId: string, work: () => Promise<T>): Promise<ActionResult<T>> {
  void storeId;
  try {
    const data = await work();
    return { ok: true, data };
  } catch (err) {
    // The API writes for this reader — "A count is already open" beats
    // anything generic this layer could put in its place.
    return { ok: false, error: err instanceof ApiError ? err.message : "That didn't work." };
  }
}

export async function openCount(storeId: string, name: string): Promise<ActionResult<CountSession>> {
  return run(storeId, () =>
    api<CountSession>(`/stores/${storeId}/inventory/counts`, { method: "POST", body: { name } }),
  );
}

export async function enterCount(
  storeId: string,
  sessionId: string,
  input: { variantId: string; countedQty: number; note?: string },
): Promise<ActionResult<CountLine>> {
  return run(storeId, () =>
    api<CountLine>(`/stores/${storeId}/inventory/counts/${sessionId}/lines`, {
      method: "POST",
      body: input,
    }),
  );
}

export async function removeCountLine(
  storeId: string,
  sessionId: string,
  variantId: string,
): Promise<ActionResult> {
  return run(storeId, async () => {
    await api(`/stores/${storeId}/inventory/counts/${sessionId}/lines/${variantId}`, {
      method: "DELETE",
    });
    return undefined;
  });
}

export interface PostResult {
  applied: number;
  unchanged: number;
  netUnits: number;
}

export async function postCount(
  storeId: string,
  sessionId: string,
): Promise<ActionResult<PostResult>> {
  return run(storeId, () =>
    api<PostResult>(`/stores/${storeId}/inventory/counts/${sessionId}/post`, { method: "POST" }),
  );
}

export async function abandonCount(storeId: string, sessionId: string): Promise<ActionResult> {
  return run(storeId, async () => {
    await api(`/stores/${storeId}/inventory/counts/${sessionId}/abandon`, { method: "POST" });
    return undefined;
  });
}
