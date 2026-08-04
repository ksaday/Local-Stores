"use client";

import { useEffect, useRef, useState } from "react";
import { uploadImage } from "@/lib/upload-image";

type Stage = "idle" | "uploading" | "processing" | "saved";

const LABEL: Record<Stage, string> = {
  idle: "Photo of where you left it",
  uploading: "Uploading…",
  processing: "Saving…",
  saved: "Replace photo",
};

/**
 * The doorstep photograph (plan Phase 9).
 *
 * Uploaded when it is taken rather than when the delivery is completed, so the
 * seconds it costs are spent while the driver walks back to the van instead of
 * in front of a button they are waiting on. The asset id is handed upwards and
 * only becomes proof of anything when they press Delivered.
 *
 * The preview is the local file, shown the instant the camera closes — there
 * is nothing to wait for to know whether the picture came out. What it does
 * *not* do is imply the picture is saved: that is said separately, because
 * "I can see it" and "the shop can see it" are different facts and only one of
 * them survives a lost signal.
 */
export function ProofCapture({
  storeId,
  onCaptured,
}: {
  storeId: string;
  onCaptured: (assetId: string | null) => void;
}) {
  const [stage, setStage] = useState<Stage>("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Object URLs hold the file in memory until they are released, and a driver
  // works through a round of them.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    onCaptured(null);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });

    try {
      const assetId = await uploadImage(storeId, "PROOF", file, setStage);
      setStage("saved");
      onCaptured(assetId);
    } catch (err) {
      setStage("idle");
      setError(err instanceof Error ? err.message : "That photo didn't save.");
    } finally {
      // Clear it, or taking the same-named photo again fires no change event.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const busy = stage === "uploading" || stage === "processing";

  return (
    <div className="space-y-3">
      {preview && (
        /* eslint-disable-next-line @next/next/no-img-element -- a blob: URL
           from the camera, which next/image cannot optimise or need to. */
        <img
          src={preview}
          alt="The photo you just took"
          // Contained, not cropped: the driver is checking whether the frame
          // came out, and a crop hides exactly the edges they are checking.
          className="max-h-48 w-full rounded-card bg-surface object-contain"
        />
      )}

      <label
        className={`flex w-full cursor-pointer items-center justify-center rounded-card border border-line px-5 py-3 text-base text-ink ${
          busy ? "opacity-60" : ""
        }`}
      >
        {LABEL[stage]}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          // Opens the rear camera on a phone and an ordinary file picker
          // everywhere else.
          capture="environment"
          disabled={busy}
          onChange={onFile}
          className="sr-only"
        />
      </label>

      {stage === "saved" && <p className="text-sm text-ink-muted">Saved. The shop can see it.</p>}
      {busy && <p className="text-sm text-ink-muted">Keep this page open until it saves.</p>}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error} You can still mark it delivered without a photo.
        </p>
      )}
    </div>
  );
}
