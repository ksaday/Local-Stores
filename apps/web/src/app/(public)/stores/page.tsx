import type { Metadata } from "next";
import Link from "next/link";
import { StoreCard } from "@/components/storefront";
import { listStores } from "@/lib/storefront";

export const metadata: Metadata = {
  title: "Browse local stores",
  description: "Find shops, restaurants and service providers near you.",
};

const FILTERS = [
  { value: "", label: "All" },
  { value: "RETAIL", label: "Shops" },
  { value: "RESTAURANT", label: "Restaurants" },
  { value: "SERVICE", label: "Services" },
];

export default async function StoreDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const { q, type } = await searchParams;
  const stores = await listStores({ q, businessType: type });

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-ink">Local stores</h1>
      <p className="mt-2 text-ink-muted">
        Every store here is run by the people who run the shop.
      </p>

      {/* A plain GET form: search works with JavaScript disabled, the result is
          a real URL a shopper can bookmark or share, and the back button does
          what they expect. */}
      <form role="search" className="mt-8 flex flex-wrap gap-3">
        <label htmlFor="q" className="sr-only">
          Search stores by name
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={q ?? ""}
          placeholder="Search by name"
          className="min-w-0 flex-1 rounded-card border border-line bg-surface px-4 py-2.5 text-ink placeholder:text-ink-muted"
        />
        {type && <input type="hidden" name="type" value={type} />}
        <button
          type="submit"
          className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
        >
          Search
        </button>
      </form>

      <nav aria-label="Filter by business type" className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = (type ?? "") === f.value;
          const params = new URLSearchParams();
          if (q) params.set("q", q);
          if (f.value) params.set("type", f.value);

          return (
            <Link
              key={f.label}
              href={`/stores${params.size ? `?${params}` : ""}`}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-ink"
                  : "rounded-full border border-line px-4 py-1.5 text-sm text-ink-muted hover:border-brand"
              }
            >
              {f.label}
            </Link>
          );
        })}
      </nav>

      {/* Announced politely so a screen reader user hears the result count
          change after searching, rather than having to go hunting for it. */}
      <p aria-live="polite" className="mt-6 text-sm text-ink-muted">
        {stores.length === 0
          ? "No stores matched."
          : `${stores.length} ${stores.length === 1 ? "store" : "stores"}`}
      </p>

      {stores.length === 0 ? (
        <p className="mt-4 text-ink-muted">
          {q ? (
            <>
              Nothing matched &ldquo;{q}&rdquo;. Try a shorter search, or{" "}
              <Link href="/stores" className="text-brand underline underline-offset-4">
                browse everything
              </Link>
              .
            </>
          ) : (
            "No stores are open yet. Check back soon."
          )}
        </p>
      ) : (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {stores.map((store) => (
            <StoreCard key={store.id} store={store} />
          ))}
        </ul>
      )}
    </main>
  );
}
