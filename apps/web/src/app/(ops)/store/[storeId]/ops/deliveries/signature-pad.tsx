"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { uploadImage } from "@/lib/upload-image";

type Point = { x: number; y: number };
type Stroke = Point[];
type Stage = "drawing" | "uploading" | "processing" | "saved";

/** Ink width in CSS pixels, before the device-pixel-ratio scale. */
const LINE_WIDTH = 2.5;

/**
 * The customer's signature at the door (plan Phase 9).
 *
 * The other half of proof, and deliberately not the same interaction as the
 * photograph: a photo is taken once and is either right or wrong, while a
 * signature is drawn, looked at, and often redone. So this one does not upload
 * as you go — the driver hands over the phone, the customer signs, and only
 * "Use this signature" spends anything. Undo removes the last stroke rather
 * than the whole thing, because the usual mistake is one bad line, not a bad
 * signature.
 *
 * Pointer events rather than touch or mouse events: a finger, a stylus and a
 * trackpad all arrive through the same handlers, which is the difference
 * between this working on the phone it was designed for and working only on
 * the laptop it was written on.
 */
export function SignaturePad({
  storeId,
  onCaptured,
}: {
  storeId: string;
  onCaptured: (assetId: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const drawing = useRef(false);

  const [stage, setStage] = useState<Stage>("drawing");
  const [hasInk, setHasInk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Repaints from the stored strokes.
   *
   * The strokes, not the pixels, are the state — undo and the resize below both
   * need to produce a picture that was never on screen in that form, and only a
   * replay can do that.
   */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Opaque white, not transparent: this is exported as an image and read on
    // screens whose background we do not control. A transparent signature is
    // invisible ink the first time somebody views it in dark mode.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width / ratio, canvas.height / ratio);

    ctx.strokeStyle = "#111111";
    ctx.fillStyle = "#111111";
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const stroke of strokes.current) {
      if (stroke.length === 0) continue;

      // A tap is a dot. Stroking a zero-length path draws nothing at all, so
      // the i-dots and full stops would silently vanish.
      if (stroke.length === 1) {
        ctx.beginPath();
        ctx.arc(stroke[0]!.x, stroke[0]!.y, LINE_WIDTH / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(stroke[0]!.x, stroke[0]!.y);
      // Curve through the midpoints rather than connecting the sampled points
      // directly: pointer samples are coarse enough that straight segments read
      // as a polygon, which does not look like anybody's handwriting.
      for (let i = 1; i < stroke.length - 1; i += 1) {
        const current = stroke[i]!;
        const next = stroke[i + 1]!;
        ctx.quadraticCurveTo(
          current.x,
          current.y,
          (current.x + next.x) / 2,
          (current.y + next.y) / 2,
        );
      }
      ctx.lineTo(stroke[stroke.length - 1]!.x, stroke[stroke.length - 1]!.y);
      ctx.stroke();
    }
  }, []);

  /**
   * Matches the backing store to the element's real size and pixel density.
   *
   * Without the ratio the line is soft on every phone made in the last decade;
   * without re-running on resize, rotating the phone stretches whatever was
   * already drawn.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const fit = () => {
      const ratio = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      redraw();
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  function pointFrom(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (stage === "uploading" || stage === "processing") return;

    // Signing over a saved signature replaces it. The id already handed up is
    // stale from this point, and saying so now stops "Delivered — signed" from
    // referring to a picture nobody can see any more.
    if (stage === "saved") {
      strokes.current = [];
      setStage("drawing");
      onCaptured(null);
    }

    // Keeps the stroke coming here even when the finger leaves the box, so
    // running off the edge ends the line cleanly instead of abandoning it.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Throws when the pointer is already gone — a finger lifted between the
      // event being queued and handled. Capture is an improvement to the
      // stroke, not a precondition for it, so draw anyway.
    }
    drawing.current = true;
    strokes.current.push([pointFrom(event)]);
    setHasInk(true);
    setError(null);
    redraw();
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    strokes.current[strokes.current.length - 1]!.push(pointFrom(event));
    redraw();
  }

  function onPointerUp() {
    drawing.current = false;
  }

  function undo() {
    strokes.current.pop();
    setHasInk(strokes.current.length > 0);
    if (stage === "saved") {
      setStage("drawing");
      onCaptured(null);
    }
    redraw();
  }

  function clear() {
    strokes.current = [];
    setHasInk(false);
    if (stage === "saved") onCaptured(null);
    setStage("drawing");
    setError(null);
    redraw();
  }

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;

    setError(null);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) {
      setError("That signature couldn't be saved. Try again.");
      return;
    }

    const file = new File([blob], "signature.png", { type: "image/png" });

    try {
      const assetId = await uploadImage(storeId, "SIGNATURE", file, setStage);
      setStage("saved");
      onCaptured(assetId);
    } catch (err) {
      setStage("drawing");
      setError(err instanceof Error ? err.message : "That signature didn't save.");
    }
  }

  const busy = stage === "uploading" || stage === "processing";

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">Ask the customer to sign (optional)</p>

      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // touch-none, or the first downward stroke scrolls the page instead of
        // drawing — which on a phone makes the pad look broken rather than busy.
        className="h-40 w-full touch-none rounded-card border border-line bg-white"
        aria-label="Signature pad"
      />

      {/* Two rows, not three buttons abreast: at 375px the third label wrapped
          mid-word. It also separates fixing the drawing from committing it,
          which are different kinds of action. */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={undo}
          disabled={!hasInk || busy}
          className="flex-1 rounded-card border border-line px-4 py-2.5 text-base text-ink disabled:opacity-60"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={!hasInk || busy}
          className="flex-1 rounded-card border border-line px-4 py-2.5 text-base text-ink disabled:opacity-60"
        >
          Clear
        </button>
      </div>

      <button
        type="button"
        onClick={save}
        disabled={!hasInk || busy || stage === "saved"}
        className="w-full rounded-card border border-line px-4 py-2.5 text-base text-ink disabled:opacity-60"
      >
        {busy ? "Saving…" : stage === "saved" ? "Signature saved" : "Use this signature"}
      </button>

      {busy && <p className="text-sm text-ink-muted">Keep this page open until it saves.</p>}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error} You can still mark it delivered without a signature.
        </p>
      )}
    </div>
  );
}
