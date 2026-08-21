import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { getStore } from "@/lib/storefront";
import { ProductImage, StoreTheme, businessTypeLabel } from "@/components/storefront";

/**
 * Loads the store, turning a 404 from the API into a Next.js not-found.
 *
 * A store that is suspended or not yet live 404s exactly like one that never
 * existed — that non-enumeration property is enforced in the API, and this is
 * just carrying it through to the page.
 *
 * The layout and the pages beneath it both call this. Next dedupes identical
 * fetches within a single render, so it is one request, not four.
 */
async function loadStore(slug: string) {
  try {
    return await getStore(slug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const store = await loadStore(slug);
  const place = [store.city, store.state].filter(Boolean).join(", ");

  return {
    title: store.name,
    description: place
      ? `${store.name} in ${place}. Shop online, direct from the store.`
      : `${store.name}. Shop online, direct from the store.`,
    openGraph: {
      title: store.name,
      type: "website",
      images: store.banner ? [{ url: store.banner.url }] : undefined,
    },
  };
}

export default async function StoreLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const store = await loadStore(slug);

  return (
    <StoreTheme theme={store.branding?.theme}>
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-5">
          {store.logo && (
            <ProductImage
              image={store.logo}
              priority
              className="h-12 w-12 rounded-card object-cover"
            />
          )}
          <div className="min-w-0">
            <Link href={`/stores/${store.slug}`} className="tap-target text-lg font-semibold text-ink">
              {store.name}
            </Link>
            <p className="text-sm text-ink-muted">
              {businessTypeLabel(store.businessType)}
              {store.city && ` · ${[store.city, store.state].filter(Boolean).join(", ")}`}
            </p>
          </div>

          {/* Always present, even when empty: a shopper needs to be able to
              find their basket without having just added something. */}
          <Link
            href={`/stores/${store.slug}/cart`}
            className="ml-auto rounded-card border border-line px-4 py-2 text-sm font-medium text-ink"
          >
            Cart
          </Link>
        </div>
      </header>

      {children}

      <footer className="mt-16 border-t border-line">
        <div className="mx-auto max-w-5xl px-6 py-8 text-sm text-ink-muted">
          <p>
            {store.name}
            {store.addressLine1 && ` · ${store.addressLine1}`}
            {store.city && `, ${[store.city, store.state, store.postalCode].filter(Boolean).join(" ")}`}
          </p>
          <p className="mt-3">
            <Link href="/stores" className="tap-target underline underline-offset-4">
              Browse other local stores
            </Link>
          </p>
        </div>
      </footer>
    </StoreTheme>
  );
}
