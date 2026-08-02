import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api";
import { Price } from "@/components/storefront";
import { getCart, getStore } from "@/lib/storefront";
import { removeCartItem, updateCartItem } from "./actions";

export const metadata: Metadata = { title: "Your cart" };

/** Cart contents are per-shopper, so this page must never be prerendered. */
export const dynamic = "force-dynamic";

export default async function CartPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let store;
  try {
    store = await getStore(slug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const cart = await getCart(store.id);
  const blocked = cart.lines.some((l) => l.problem?.kind === "unavailable" || l.problem?.kind === "insufficient_stock");

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Your cart</h1>

      {cart.lines.length === 0 ? (
        <div className="mt-8">
          <p className="text-ink-muted">Your cart is empty.</p>
          <Link
            href={`/stores/${slug}`}
            className="mt-4 inline-block rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
          >
            Browse {store.name}
          </Link>
        </div>
      ) : (
        <>
          <ul className="mt-8 divide-y divide-line border-y border-line">
            {cart.lines.map((line) => (
              <li key={line.id} className="flex flex-wrap items-start gap-4 py-5">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/stores/${slug}/products/${line.productSlug}`}
                    className="font-medium text-ink hover:underline"
                  >
                    {line.productName}
                  </Link>
                  {Object.keys(line.variantAttrs).length > 0 && (
                    <p className="text-sm text-ink-muted">
                      {Object.entries(line.variantAttrs)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(", ")}
                    </p>
                  )}

                  {/* Problems are stated, never silently fixed. A cart that
                      quietly changes quantities under the shopper is worse
                      than one that explains itself. */}
                  {line.problem?.kind === "unavailable" && (
                    <p className="mt-2 text-sm text-danger">{line.problem.detail}</p>
                  )}
                  {line.problem?.kind === "insufficient_stock" && (
                    <p className="mt-2 text-sm text-danger">
                      {line.problem.availableQty === 0
                        ? "Sold out."
                        : `Only ${line.problem.availableQty} left — reduce the quantity to continue.`}
                    </p>
                  )}
                  {line.problem?.kind === "price_changed" && (
                    <p className="mt-2 text-sm text-ink-muted">
                      The price changed since you added this.
                    </p>
                  )}
                </div>

                <form action={updateCartItem} className="flex items-center gap-2">
                  <input type="hidden" name="storeId" value={store.id} />
                  <input type="hidden" name="storeSlug" value={slug} />
                  <input type="hidden" name="itemId" value={line.id} />
                  <label htmlFor={`qty-${line.id}`} className="sr-only">
                    Quantity of {line.productName}
                  </label>
                  <input
                    id={`qty-${line.id}`}
                    name="qty"
                    type="number"
                    min={1}
                    max={99}
                    defaultValue={line.qty}
                    className="w-16 rounded-card border border-line bg-surface px-2 py-1.5 text-center text-ink"
                  />
                  <button type="submit" className="text-sm text-brand underline underline-offset-4">
                    Update
                  </button>
                </form>

                <div className="w-24 text-right">
                  <Price cents={line.lineTotalCents} currency={store.currency} />
                </div>

                <form action={removeCartItem}>
                  <input type="hidden" name="storeId" value={store.id} />
                  <input type="hidden" name="storeSlug" value={slug} />
                  <input type="hidden" name="itemId" value={line.id} />
                  <button type="submit" className="text-sm text-ink-muted hover:text-danger">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>

          <div className="mt-6 flex items-center justify-between">
            <span className="text-sm text-ink-muted">Subtotal</span>
            <Price cents={cart.subtotalCents} currency={store.currency} />
          </div>
          <p className="mt-1 text-right text-sm text-ink-muted">
            Tax and any delivery fee are calculated at checkout.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            {blocked ? (
              <>
                <span className="rounded-card bg-surface-muted px-5 py-2.5 text-sm text-ink-muted">
                  Checkout
                </span>
                <p className="text-sm text-danger">
                  Fix the items flagged above to continue.
                </p>
              </>
            ) : (
              <Link
                href={`/stores/${slug}/checkout`}
                className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
              >
                Checkout
              </Link>
            )}
            <Link href={`/stores/${slug}`} className="text-sm text-brand underline underline-offset-4">
              Keep shopping
            </Link>
          </div>
        </>
      )}
    </main>
  );
}
