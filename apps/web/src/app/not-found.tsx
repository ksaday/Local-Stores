import type { Metadata } from "next";
import Link from "next/link";

// Without this the tab shows the bare URL, which is the one place a 404 still
// leaks a technical string at somebody.
export const metadata: Metadata = { title: "Page not found" };

/**
 * What somebody sees when a page is not there (plan §6.4: no dead ends).
 *
 * Without this, Next renders its own: "404: This page could not be found",
 * unstyled, with no link out and nothing identifying the site. It is reached
 * more often than a mistyped URL suggests — a shop that has closed, a product
 * taken off sale, a bookmark from last year, and every `notFound()` the app
 * calls deliberately.
 *
 * The copy does not apologise for a fault, because usually there isn't one:
 * something was removed, which is a normal thing for a shop to do. It says
 * what probably happened and offers the two places worth going.
 */
export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-lg px-6 py-24 text-center">
      <h1 className="text-lg font-semibold text-ink">We couldn&rsquo;t find that page</h1>
      <p className="mt-2 text-sm text-ink-muted">
        It may have moved, or the shop may have taken it down. Links from a while ago sometimes
        go stale this way.
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          href="/stores"
          className="tap-target rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
        >
          Browse local shops
        </Link>
        <Link
          href="/account"
          className="tap-target rounded-card border border-line px-5 py-2.5 text-sm text-ink"
        >
          Your account
        </Link>
      </div>
    </main>
  );
}
