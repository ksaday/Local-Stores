import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api";
import { JsonLd, Price, ProductImage } from "@/components/storefront";
import { getProduct } from "@/lib/storefront";
import { AddToCart } from "./add-to-cart";

async function load(slug: string, productSlug: string) {
  try {
    return await getProduct(slug, productSlug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; productSlug: string }>;
}): Promise<Metadata> {
  const { slug, productSlug } = await params;
  const { store, product } = await load(slug, productSlug);

  return {
    title: `${product.name} · ${store.name}`,
    description: product.description?.slice(0, 160) ?? `${product.name} from ${store.name}.`,
    openGraph: {
      title: product.name,
      type: "website",
      images: product.images[0] ? [{ url: product.images[0].url }] : undefined,
    },
  };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string; productSlug: string }>;
}) {
  const { slug, productSlug } = await params;
  const { store, product } = await load(slug, productSlug);

  const defaultVariant = product.variants.find((v) => v.isDefault) ?? product.variants[0];
  const prices = product.variants.map((v) => v.priceCents);
  const hasRange = prices.length > 1 && Math.min(...prices) !== Math.max(...prices);

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Product",
          name: product.name,
          description: product.description ?? undefined,
          brand: product.brand ? { "@type": "Brand", name: product.brand } : undefined,
          image: product.images.map((i) => i.url),
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: store.currency,
            lowPrice: (Math.min(...prices) / 100).toFixed(2),
            highPrice: (Math.max(...prices) / 100).toFixed(2),
            offerCount: product.variants.length,
            // No availability claim: stock tracking is optional per store, so
            // asserting InStock would be a promise we cannot keep for a shop
            // that doesn't count.
            seller: { "@type": "Organization", name: store.name },
          },
        }}
      />

      <nav aria-label="Breadcrumb" className="text-sm text-ink-muted">
        <ol className="flex flex-wrap items-center gap-2">
          <li>
            <Link href={`/stores/${slug}`} className="hover:text-ink">
              {store.name}
            </Link>
          </li>
          {product.category && (
            <li className="flex items-center gap-2">
              <span aria-hidden>/</span>
              <Link
                href={`/stores/${slug}?category=${product.category.slug}`}
                className="hover:text-ink"
              >
                {product.category.name}
              </Link>
            </li>
          )}
          <li className="flex items-center gap-2">
            <span aria-hidden>/</span>
            <span aria-current="page" className="text-ink">
              {product.name}
            </span>
          </li>
        </ol>
      </nav>

      <div className="mt-8 gap-10 md:flex">
        <div className="md:w-1/2">
          <ProductImage
            image={product.images[0] ?? null}
            priority
            sizes="(min-width: 768px) 480px, 90vw"
            className="aspect-square w-full rounded-card object-cover"
          />
          {product.images.length > 1 && (
            <ul className="mt-4 grid grid-cols-4 gap-3">
              {product.images.slice(1).map((image, i) => (
                <li key={image.url}>
                  <ProductImage
                    image={image}
                    sizes="120px"
                    className="aspect-square w-full rounded-card object-cover"
                  />
                  <span className="sr-only">
                    {product.name}, image {i + 2} of {product.images.length}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-8 md:mt-0 md:w-1/2">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{product.name}</h1>
          {product.brand && <p className="mt-1 text-ink-muted">{product.brand}</p>}

          <div className="mt-4">
            {hasRange ? (
              <p className="text-lg font-semibold tabular-nums">
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: store.currency,
                }).format(Math.min(...prices) / 100)}
                {" – "}
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: store.currency,
                }).format(Math.max(...prices) / 100)}
              </p>
            ) : (
              defaultVariant && (
                <Price
                  cents={defaultVariant.priceCents}
                  compareAtCents={defaultVariant.compareAtCents}
                  currency={store.currency}
                />
              )
            )}
          </div>

          <AddToCart
            storeId={store.id}
            storeSlug={slug}
            variants={product.variants}
            currency={store.currency}
          />

          {store.cashEnabled && (
            <p className="mt-6 text-sm text-ink-muted">
              Pay in person when you collect. Card payments are coming soon.
            </p>
          )}

          {product.description && (
            <section className="mt-8">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                Details
              </h2>
              {/* Rendered as text, not HTML: descriptions are owner-authored and
                  must never be able to inject markup into a public page. */}
              <p className="mt-3 whitespace-pre-line text-ink">{product.description}</p>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
