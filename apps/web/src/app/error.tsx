"use client";

import Link from "next/link";

/**
 * The catch-all, for everything outside the ops shell — storefronts, the cart,
 * the account pages.
 *
 * Same reason as the ops boundary: without one, a failure anywhere renders
 * Next's own "Application error … Digest: 1999543842", which tells a shopper
 * nothing and offers them nowhere to go. This is the shopper-facing wording,
 * so it talks about the shop rather than about screens and roles.
 */
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="main" className="mx-auto max-w-lg px-6 py-24 text-center">
      <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
      <p className="mt-2 text-sm text-ink-muted">
        We couldn&rsquo;t load this page. Nothing you were doing has been lost — if you were
        placing an order, it hasn&rsquo;t been sent.
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
        >
          Try again
        </button>
        <Link
          href="/stores"
          className="rounded-card border border-line px-5 py-2.5 text-sm text-ink"
        >
          Browse local stores
        </Link>
      </div>
    </main>
  );
}
