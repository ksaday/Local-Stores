import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api";
import { JsonLd, Price, ProductImage } from "@/components/storefront";
import { listCategories, listProducts } from "@/lib/storefront";

const SORTS = [
  { value: "", label: "Featured" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "newest", label: "Newest" },
];

const PAGE_SIZE = 24;

export default async function StorefrontPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; category?: string; sort?: string; page?: string }>;
}) {
  const { slug } = await params;
  const { q, category, sort, page } = await searchParams;

  // A hand-typed ?page=abc or ?page=-3 must not reach the API as-is.
  const pageNumber = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);
  const offset = (pageNumber - 1) * PAGE_SIZE;

  let data;
  try {
    [data] = await Promise.all([
      listProducts(slug, { q, categorySlug: category, sort, limit: PAGE_SIZE, offset }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const { store, products, total } = data;
  const categories = await listCategories(slug);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const buildHref = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { q, category, sort, page: String(pageNumber), ...overrides };
    for (const [key, value] of Object.entries(merged)) {
      if (value && !(key === "page" && value === "1")) next.set(key, value);
    }
    return `/stores/${slug}${next.size ? `?${next}` : ""}`;
  };

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Store",
          name: store.name,
          url: `/stores/${store.slug}`,
          ...(store.addressLine1 || store.city
            ? {
                address: {
                  "@type": "PostalAddress",
                  streetAddress: store.addressLine1 ?? undefined,
                  addressLocality: store.city ?? undefined,
                  addressRegion: store.state ?? undefined,
                  postalCode: store.postalCode ?? undefined,
                  addressCountry: "US",
                },
              }
            : {}),
        }}
      />

      {store.banner && (
        <ProductImage
          image={store.banner}
          priority
          className="mb-8 h-48 w-full rounded-card object-cover sm:h-64"
        />
      )}

      <form role="search" className="flex flex-wrap gap-3">
        <label htmlFor="q" className="sr-only">
          Search {store.name}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={q ?? ""}
          placeholder={`Search ${store.name}`}
          className="min-w-0 flex-1 rounded-card border border-line bg-surface px-4 py-2.5 text-ink placeholder:text-ink-muted"
        />
        {category && <input type="hidden" name="category" value={category} />}
        {sort && <input type="hidden" name="sort" value={sort} />}
        <button
          type="submit"
          className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
        >
          Search
        </button>
      </form>

      <div className="mt-8 gap-10 lg:flex">
        {categories.length > 0 && (
          <nav aria-label="Categories" className="mb-8 lg:mb-0 lg:w-52 lg:shrink-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
              Categories
            </h2>
            <ul className="mt-3 space-y-1 text-sm">
              <li>
                <Link
                  href={buildHref({ category: undefined, page: "1" })}
                  aria-current={!category ? "page" : undefined}
                  className={category ? "text-ink-muted hover:text-ink" : "font-medium text-brand"}
                >
                  All products
                </Link>
              </li>
              {categories.map((c) => (
                <li key={c.id}>
                  <Link
                    href={buildHref({ category: c.slug, page: "1" })}
                    aria-current={category === c.slug ? "page" : undefined}
                    className={
                      category === c.slug ? "font-medium text-brand" : "text-ink-muted hover:text-ink"
                    }
                  >
                    {c.name}
                  </Link>
                  {c.children.length > 0 && (
                    <ul className="ml-3 mt-1 space-y-1 border-l border-line pl-3">
                      {c.children.map((child) => (
                        <li key={child.id}>
                          <Link
                            href={buildHref({ category: child.slug, page: "1" })}
                            aria-current={category === child.slug ? "page" : undefined}
                            className={
                              category === child.slug
                                ? "font-medium text-brand"
                                : "text-ink-muted hover:text-ink"
                            }
                          >
                            {child.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p aria-live="polite" className="text-sm text-ink-muted">
              {total === 0 ? "Nothing here yet" : `${total} ${total === 1 ? "item" : "items"}`}
            </p>
            <nav aria-label="Sort" className="flex flex-wrap gap-2 text-sm">
              {SORTS.map((s) => (
                <Link
                  key={s.label}
                  href={buildHref({ sort: s.value || undefined, page: "1" })}
                  aria-current={(sort ?? "") === s.value ? "page" : undefined}
                  className={
                    (sort ?? "") === s.value
                      ? "font-medium text-brand"
                      : "text-ink-muted hover:text-ink"
                  }
                >
                  {s.label}
                </Link>
              ))}
            </nav>
          </div>

          {products.length === 0 ? (
            <p className="mt-8 text-ink-muted">
              {q ? `Nothing matched “${q}”.` : "This store hasn’t listed anything yet."}
            </p>
          ) : (
            <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((product) => (
                <li key={product.id}>
                  <Link
                    href={`/stores/${slug}/products/${product.slug}`}
                    className="group flex h-full flex-col"
                  >
                    <ProductImage
                      image={product.image}
                      sizes="(min-width: 1024px) 240px, (min-width: 640px) 45vw, 90vw"
                      className="aspect-square w-full rounded-card object-cover"
                    />
                    <span className="mt-3 font-medium text-ink group-hover:underline">
                      {product.name}
                    </span>
                    {product.brand && (
                      <span className="text-sm text-ink-muted">{product.brand}</span>
                    )}
                    <div className="mt-1">
                      <Price
                        cents={product.priceCents}
                        compareAtCents={product.compareAtCents}
                        currency={store.currency}
                      />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {lastPage > 1 && (
            <nav aria-label="Pagination" className="mt-10 flex items-center justify-between text-sm">
              {pageNumber > 1 ? (
                <Link
                  href={buildHref({ page: String(pageNumber - 1) })}
                  rel="prev"
                  className="text-brand underline underline-offset-4"
                >
                  ← Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-ink-muted">
                Page {pageNumber} of {lastPage}
              </span>
              {pageNumber < lastPage ? (
                <Link
                  href={buildHref({ page: String(pageNumber + 1) })}
                  rel="next"
                  className="text-brand underline underline-offset-4"
                >
                  Next →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </div>
      </div>
    </main>
  );
}
