import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { ApiError, api } from "@/lib/api";
import { getCart, getStore, type Quote } from "@/lib/storefront";
import { CheckoutForm } from "./checkout-form";

export const metadata: Metadata = { title: "Checkout" };

/** Depends on the shopper's cart, so it can never be prerendered or shared. */
export const dynamic = "force-dynamic";

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let store;
  try {
    store = await getStore(slug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const cart = await getCart(store.id);
  // Nothing to check out. Sending them to the cart is more useful than an
  // empty form that cannot be submitted.
  if (cart.lines.length === 0) redirect(`/stores/${slug}/cart`);

  // Quote pickup up front so the shopper sees a real total immediately rather
  // than an empty summary panel.
  let initialQuote: Quote | null = null;
  try {
    initialQuote = await api<Quote>(`/stores/${store.id}/checkout/quote`, {
      method: "POST",
      body: { fulfillment: "PICKUP" },
    });
  } catch {
    // A quote failure here is not fatal — the form re-quotes on interaction.
    initialQuote = null;
  }

  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-ink-muted">
        <Link href={`/stores/${slug}/cart`} className="hover:text-ink">
          Cart
        </Link>
        <span aria-hidden className="mx-2">/</span>
        <span aria-current="page" className="text-ink">Checkout</span>
      </nav>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">Checkout</h1>

      <CheckoutForm
        storeId={store.id}
        storeSlug={slug}
        currency={store.currency}
        cashEnabled={store.cashEnabled}
        // Minted once per page render. A resubmit reuses it, so a double click
        // or a browser retry returns the first order instead of a second one.
        idempotencyKey={randomUUID()}
        initialQuote={initialQuote}
      />
    </main>
  );
}
