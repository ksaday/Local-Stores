"use server";

import { revalidatePath } from "next/cache";
import { ApiError, api } from "@/lib/api";

export interface ImportState {
  result: {
    created: number;
    updated: number;
    skipped: number;
    errors: { line: number; sku: string | null; message: string }[];
  } | null;
  error: string | null;
}

/**
 * Imports a CSV of products.
 *
 * The file is read in the browser and sent as text rather than as a multipart
 * upload: it is a few hundred KB of plain text at most, and this keeps the
 * whole path through the BFF as ordinary JSON.
 */
export async function importCatalogCsv(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const storeId = String(formData.get("storeId") ?? "");
  const csv = String(formData.get("csv") ?? "").trim();

  if (!csv) return { result: null, error: "Choose a file, or paste some rows." };

  try {
    const result = await api<ImportState["result"]>(`/stores/${storeId}/catalog.csv`, {
      method: "POST",
      body: { csv },
    });
    revalidatePath(`/store/${storeId}/ops/catalog`);
    return { result, error: null };
  } catch (err) {
    return {
      result: null,
      error: err instanceof ApiError ? err.message : "Couldn't import that file.",
    };
  }
}

// ── Product photos (plan §13.7) ────────────────────────────────────────────
//
// Getting the file into storage is `lib/upload-image`, shared with delivery
// proofs. What is specific to the catalog is only what happens afterwards:
// claiming the finished asset for a product.

/**
 * Attaches a processed asset to a product.
 *
 * Separate from completing the upload: an asset exists on its own until
 * something claims it, and the API refuses to attach one that is not READY —
 * a half-processed image must never appear on a storefront.
 */
export async function attachProductImage(
  storeId: string,
  productId: string,
  input: { mediaAssetId: string; alt?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await api(`/stores/${storeId}/products/${productId}/images`, {
      method: "POST",
      body: input,
    });
    revalidatePath(`/store/${storeId}/ops/catalog/products/${productId}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof ApiError ? err.message : "Couldn't add that photo.",
    };
  }
}

export async function removeProductImage(
  storeId: string,
  productId: string,
  imageId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await api(`/stores/${storeId}/images/${imageId}`, { method: "DELETE" });
    revalidatePath(`/store/${storeId}/ops/catalog/products/${productId}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof ApiError ? err.message : "Couldn't remove that photo.",
    };
  }
}
