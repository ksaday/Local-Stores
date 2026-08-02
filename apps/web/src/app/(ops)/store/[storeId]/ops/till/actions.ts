"use server";

import { revalidatePath } from "next/cache";
import { ApiError, api } from "@/lib/api";

export interface TillItem {
  variantId: string;
  name: string;
  attrs: Record<string, string>;
  sku: string | null;
  barcode: string | null;
  priceCents: number;
  /** Null means this store doesn't count this item — not that it has none. */
  availableQty: number | null;
}

export interface SaleResult {
  id: string;
  orderNumber: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  tenderedCents: number | null;
  changeCents: number | null;
}

export interface TillState {
  sale: SaleResult | null;
  error: string | null;
}

/** Barcode scan or typed search, for adding a line at the counter. */
export async function lookupItem(storeId: string, code: string): Promise<TillItem[]> {
  if (!code.trim()) return [];
  try {
    return await api<TillItem[]>(
      `/stores/${storeId}/pos/lookup?code=${encodeURIComponent(code)}`,
      { revalidate: false },
    );
  } catch {
    // A failed lookup must not break the till — the clerk can retype or pick
    // from the grid, and an empty result says "not found" clearly enough.
    return [];
  }
}

export async function ringUpSale(_prev: TillState, formData: FormData): Promise<TillState> {
  const storeId = String(formData.get("storeId") ?? "");
  const linesRaw = String(formData.get("lines") ?? "[]");
  const tendered = String(formData.get("tenderedCents") ?? "").trim();

  let lines: { variantId: string; qty: number }[];
  try {
    lines = JSON.parse(linesRaw) as { variantId: string; qty: number }[];
  } catch {
    return { sale: null, error: "Something went wrong reading the sale. Start it again." };
  }

  if (lines.length === 0) return { sale: null, error: "Add something to the sale first." };

  try {
    const sale = await api<SaleResult>(`/stores/${storeId}/pos/sales`, {
      method: "POST",
      body: {
        lines,
        ...(tendered ? { tenderedCents: Math.round(Number(tendered) * 100) } : {}),
        note: String(formData.get("note") ?? "").trim() || null,
        idempotencyKey: String(formData.get("idempotencyKey") ?? ""),
      },
    });

    revalidatePath(`/store/${storeId}/ops/orders`);
    return { sale, error: null };
  } catch (err) {
    return {
      sale: null,
      error: err instanceof ApiError ? err.message : "Couldn't complete that sale.",
    };
  }
}
