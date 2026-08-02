"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { addToCart, type CartActionState } from "../../cart/actions";

const EMPTY: CartActionState = { error: null };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-card bg-brand px-6 py-3 text-sm font-medium text-brand-ink disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add to cart"}
    </button>
  );
}

export function AddToCart({
  storeId,
  storeSlug,
  variants,
  currency,
}: {
  storeId: string;
  storeSlug: string;
  variants: { id: string; attrs: Record<string, string>; priceCents: number; isDefault: boolean }[];
  currency: string;
}) {
  const [state, run] = useActionState(addToCart, EMPTY);
  const [variantId, setVariantId] = useState(
    () => (variants.find((v) => v.isDefault) ?? variants[0])?.id ?? "",
  );

  const describe = (attrs: Record<string, string>) =>
    Object.entries(attrs)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ") || "Standard";

  return (
    <form action={run} className="mt-6 space-y-4">
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="storeSlug" value={storeSlug} />
      <input type="hidden" name="variantId" value={variantId} />

      {variants.length > 1 && (
        <fieldset>
          <legend className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Choose an option
          </legend>
          <div className="mt-2 space-y-2">
            {variants.map((variant) => (
              <label
                key={variant.id}
                className={`flex cursor-pointer items-center justify-between rounded-card border px-4 py-2.5 text-sm ${
                  variantId === variant.id ? "border-brand text-brand" : "border-line text-ink"
                }`}
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="variantChoice"
                    checked={variantId === variant.id}
                    onChange={() => setVariantId(variant.id)}
                    className="sr-only"
                  />
                  {describe(variant.attrs)}
                </span>
                <span className="tabular-nums">
                  {new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
                    variant.priceCents / 100,
                  )}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex items-end gap-3">
        <label className="block">
          <span className="text-sm text-ink">Quantity</span>
          <input
            name="qty"
            type="number"
            min={1}
            max={99}
            defaultValue={1}
            className="mt-1 w-20 rounded-card border border-line bg-surface px-3 py-2 text-ink"
          />
        </label>
        <Submit />
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
