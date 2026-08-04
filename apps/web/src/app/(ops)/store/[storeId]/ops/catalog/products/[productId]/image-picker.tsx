"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadImage } from "@/lib/upload-image";
import { attachProductImage } from "../../actions";

type Stage = "idle" | "uploading" | "processing" | "attaching";

const LABEL: Record<Stage, string> = {
  idle: "Add a photo",
  uploading: "Uploading…",
  processing: "Processing…",
  attaching: "Adding…",
};

export function ImagePicker({ storeId, productId }: { storeId: string; productId: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);

    try {
      const assetId = await uploadImage(storeId, "PRODUCT", file, setStage);

      setStage("attaching");
      const attached = await attachProductImage(storeId, productId, {
        mediaAssetId: assetId,
        alt: file.name.replace(/\.[^.]+$/, ""),
      });
      if (!attached.ok) throw new Error(attached.error);

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong adding that photo.");
    } finally {
      setStage("idle");
      // Clear it, or choosing the same file again fires no change event.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const busy = stage !== "idle";

  return (
    <div className="space-y-3">
      <label
        className={`inline-flex cursor-pointer items-center rounded-card border border-line px-5 py-2.5 text-sm font-medium text-ink ${
          busy ? "opacity-60" : ""
        }`}
      >
        {LABEL[stage]}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          disabled={busy}
          onChange={onFile}
          className="sr-only"
        />
      </label>

      <p className="text-sm text-ink-muted">
        JPEG, PNG, WebP or AVIF, up to 10 MB. Photos are re-encoded and resized for
        you, and location data from a phone camera is removed.
      </p>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
