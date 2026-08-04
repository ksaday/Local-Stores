"use server";

import { api } from "./api";

/**
 * The three server-side steps of the upload flow (plan §13.7).
 *
 * Shared rather than written per feature, because the middle step — the PUT —
 * is done by the browser and must be given exactly what the API handed out.
 * A second copy of this would be a second chance to send the wrong header and
 * get a signature mismatch out of storage.
 *
 * `kind` decides both where the file lands and who may put it there: the API
 * checks a different permission for each, so a clerk who can edit the catalog
 * cannot use this to write a delivery proof.
 */
export type UploadKind = "PRODUCT" | "BRANDING" | "PROOF" | "SIGNATURE";

export interface UploadGrant {
  assetId: string;
  upload: { url: string; method: "PUT"; headers: Record<string, string>; maxBytes: number };
}

export interface AssetState {
  assetId: string;
  status: "PENDING" | "READY" | "REJECTED";
  /** Null for private kinds — proofs are never given a public URL. */
  url: string | null;
  reason?: string;
}

/**
 * Step one: ask the API where to put the file.
 *
 * The browser does the PUT itself, straight to storage, which is the whole
 * point of the three-step flow — the bytes never pass through this app or the
 * API. All that crosses here is a declared type and a size.
 */
export async function requestMediaUpload(
  storeId: string,
  kind: UploadKind,
  input: { mime: string; bytes: number; originalName?: string },
): Promise<UploadGrant> {
  return api<UploadGrant>(`/stores/${storeId}/media/upload-url`, {
    method: "POST",
    body: { kind, ...input },
  });
}

/** Step three: the file is uploaded; queue it for validation and re-encoding. */
export async function completeMediaUpload(storeId: string, assetId: string): Promise<AssetState> {
  return api<AssetState>(`/stores/${storeId}/media/${assetId}/complete`, { method: "POST" });
}

/** Polled while the worker works. Seconds, usually. */
export async function mediaAssetStatus(storeId: string, assetId: string): Promise<AssetState> {
  return api<AssetState>(`/stores/${storeId}/media/${assetId}`);
}
