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
