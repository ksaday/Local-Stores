"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { removeProductImage } from "../../actions";

export function RemoveImageButton({
  storeId,
  productId,
  imageId,
}: {
  storeId: string;
  productId: string;
  imageId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const result = await removeProductImage(storeId, productId, imageId);
    if (!result.ok) setError(result.error);
    else router.refresh();
    setBusy(false);
  }

  return (
    <div>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        className="text-sm text-ink-muted underline underline-offset-4 disabled:opacity-60"
      >
        {busy ? "Removing…" : "Remove"}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
