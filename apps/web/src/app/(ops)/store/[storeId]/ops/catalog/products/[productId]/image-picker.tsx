"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  attachProductImage,
  completeImageUpload,
  imageStatus,
  requestImageUpload,
} from "../../actions";

type Stage = "idle" | "uploading" | "processing" | "attaching";

const LABEL: Record<Stage, string> = {
  idle: "Add a photo",
  uploading: "Uploading…",
  processing: "Processing…",
  attaching: "Adding…",
};

/** Roughly a minute of polling. The worker normally takes a second or two. */
const POLL_INTERVAL_MS = 700;
const POLL_ATTEMPTS = 85;

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
      setStage("uploading");
      const { assetId, upload } = await requestImageUpload(storeId, {
        mime: file.type,
        bytes: file.size,
        originalName: file.name,
      });

      // Straight to storage, not through this app. `credentials: omit` on
      // purpose: the grant in the URL is the whole authority, and in production
      // this request goes to S3, which has no idea what our cookies are.
      const put = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: file,
        credentials: "omit",
      });
      if (!put.ok) throw new Error("The upload didn't go through. Try again.");

      setStage("processing");
      await completeImageUpload(storeId, assetId);

      const ready = await pollUntilReady(storeId, assetId);
      if (ready.status === "REJECTED") {
        // The worker looked at the actual bytes and refused them. Its reason is
        // written for the person who chose the file.
        throw new Error(ready.reason ?? "That file couldn't be used as a photo.");
      }

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

/**
 * Waits for the worker to finish with the image.
 *
 * Polling rather than a stream: this happens once, takes a second or two, and
 * an SSE connection for it would be more moving parts than the thing it
 * watches. Gives up eventually rather than spinning forever — a job that has
 * genuinely died should show as a failure, not as a button that never settles.
 */
async function pollUntilReady(storeId: string, assetId: string) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const state = await imageStatus(storeId, assetId);
    if (state.status !== "PENDING") return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("That photo is taking longer than expected. Reload in a moment to check.");
}
