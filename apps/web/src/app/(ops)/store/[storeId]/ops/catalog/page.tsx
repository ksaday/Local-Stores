import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, StatusBadge } from "@/components/shell";
import { api } from "@/lib/api";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Catalog" };
export const dynamic = "force-dynamic";

interface ProductRow {
  id: string;
  name: string;
  brand: string | null;
  sku: string | null;
  status: string;
  images: { url: string | null; alt: string | null }[];
  variants: { priceCents: number }[];
}

export default async function CatalogPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const products = await api<ProductRow[]>(`/stores/${storeId}/products`, { revalidate: false });

  return (
    <div className="mt-8 space-y-6">
      <Card title="Your products" description="Open one to manage its photos.">
        {products.length === 0 ? (
          <EmptyState
            title="No products yet"
            hint="Import a spreadsheet below to get started."
          />
        ) : (
          <ul className="divide-y divide-line">
            {products.map((product) => {
              const price = product.variants[0]?.priceCents;
              const thumb = product.images[0];
              return (
                <li key={product.id}>
                  <Link
                    href={`/store/${storeId}/ops/catalog/products/${product.id}`}
                    className="flex items-center gap-4 py-3"
                  >
                    {/* A fixed-size slot whether or not there is a photo, so the
                        rows do not jump around as images are added. */}
                    <span className="size-12 shrink-0 overflow-hidden rounded-card border border-line bg-surface">
                      {thumb?.url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumb.url}
                          alt={thumb.alt ?? ""}
                          className="size-full object-cover"
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{product.name}</span>
                      <span className="block truncate text-sm text-ink-muted">
                        {[
                          product.brand,
                          product.sku && `SKU ${product.sku}`,
                          price !== undefined && `$${(price / 100).toFixed(2)}`,
                          !thumb?.url && "No photo",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <StatusBadge status={product.status} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title="Export your catalog"
        description="A spreadsheet of everything you sell."
      >
        <p className="text-sm text-ink-muted">
          Open it in Excel or Numbers, make your changes, and import it back. Prices
          are written as ordinary amounts, so 8.00 means $8.00.
        </p>
        {/* A plain link, not a fetch: the browser's own download handling is
            better than anything reimplemented, and it works without JS. */}
        <a
          href={`/api/stores/${storeId}/catalog.csv`}
          className="mt-4 inline-block rounded-card border border-line px-5 py-2.5 text-sm font-medium text-ink"
        >
          Download catalog.csv
        </a>
      </Card>

      <Card title="Import products" description="Add or update products from a spreadsheet.">
        <div className="space-y-4">
          <div className="text-sm text-ink-muted">
            <p>
              Products are matched on <strong>SKU</strong>. A row whose SKU you already
              use updates that product; anything else is added as a draft.
            </p>
            <p className="mt-2">
              The only columns that must be present are <code>name</code> and{" "}
              <code>price</code>. Also understood: <code>sku</code>, <code>brand</code>,{" "}
              <code>description</code>, <code>category</code>,{" "}
              <code>compare_at_price</code>, <code>barcode</code>.
            </p>
            <p className="mt-2">
              Rows that can&rsquo;t be read are reported and skipped — the rest of the
              file still imports.
            </p>
          </div>

          <ImportForm storeId={storeId} />
        </div>
      </Card>
    </div>
  );
}
