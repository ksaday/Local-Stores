"use server";

import { revalidatePath } from "next/cache";
import { ApiError, api } from "@/lib/api";

export type ActionResult = { ok: true } | { ok: false; error: string };

async function run(storeId: string, work: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await work();
    revalidatePath(`/store/${storeId}/ops/inventory`);
    return { ok: true };
  } catch (err) {
    // The API's message is written for this reader — "there are 3 on hand"
    // beats anything generic this layer could substitute.
    return { ok: false, error: err instanceof ApiError ? err.message : "That didn't work." };
  }
}

export async function receiveStock(
  storeId: string,
  input: { variantId: string; qty: number; note?: string },
): Promise<ActionResult> {
  return run(storeId, () =>
    api(`/stores/${storeId}/inventory/receive`, { method: "POST", body: input }),
  );
}

export async function adjustStock(
  storeId: string,
  input: { variantId: string; qtyDelta: number; reason: string; note?: string },
): Promise<ActionResult> {
  return run(storeId, () =>
    api(`/stores/${storeId}/inventory/adjust`, { method: "POST", body: input }),
  );
}

export async function setTracking(
  storeId: string,
  variantId: string,
  input: { tracked: boolean; reorderPoint?: number | null; reorderQty?: number | null },
): Promise<ActionResult> {
  return run(storeId, () =>
    api(`/stores/${storeId}/inventory/variants/${variantId}/tracking`, {
      method: "PATCH",
      body: input,
    }),
  );
}

export interface Movement {
  id: string;
  type: string;
  qty_delta: number;
  reason_code: string | null;
  note: string | null;
  order_id: string | null;
  actor_name: string | null;
  created_at: string;
}

export async function loadMovements(storeId: string, variantId: string): Promise<Movement[]> {
  return api<Movement[]>(`/stores/${storeId}/inventory/variants/${variantId}/movements`);
}
