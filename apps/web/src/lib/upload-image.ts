import {
  completeMediaUpload,
  mediaAssetStatus,
  requestMediaUpload,
  type UploadKind,
} from "./media-upload";

/** What the caller shows while this runs. */
export type UploadStage = "uploading" | "processing";

/** Roughly a minute of polling. The worker normally takes a second or two. */
const POLL_INTERVAL_MS = 700;
const POLL_ATTEMPTS = 85;

/**
 * Puts one image through the whole pipeline and returns its asset id.
 *
 * Runs in the browser: the PUT goes straight to storage rather than through
 * this app, which is the property §13.7 exists for. Everything here is the
 * choreography around that — asking permission, waiting for the worker, and
 * turning each way it can fail into something the person holding the phone can
 * act on.
 *
 * Throws rather than returning a result union, because every caller's response
 * to a failure is to show the message and stop.
 */
export async function uploadImage(
  storeId: string,
  kind: UploadKind,
  file: File,
  onStage?: (stage: UploadStage) => void,
): Promise<string> {
  onStage?.("uploading");
  const { assetId, upload } = await requestMediaUpload(storeId, kind, {
    mime: file.type,
    bytes: file.size,
    originalName: file.name,
  });

  // `credentials: omit` on purpose: the grant in the URL is the whole
  // authority, and in production this request goes to S3, which has no idea
  // what our cookies are.
  const put = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: file,
    credentials: "omit",
  });
  if (!put.ok) throw new Error("The upload didn't go through. Try again.");

  onStage?.("processing");
  await completeMediaUpload(storeId, assetId);

  const ready = await pollUntilReady(storeId, assetId);
  if (ready.status === "REJECTED") {
    // The worker looked at the actual bytes and refused them. Its reason is
    // written for the person who chose the file.
    throw new Error(ready.reason ?? "That file couldn't be used as a photo.");
  }

  return assetId;
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
    const state = await mediaAssetStatus(storeId, assetId);
    if (state.status !== "PENDING") return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("That photo is taking longer than expected. Reload in a moment to check.");
}
