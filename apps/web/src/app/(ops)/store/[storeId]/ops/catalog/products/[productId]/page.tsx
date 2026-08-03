import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, EmptyState, StatusBadge } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { ImagePicker } from "./image-picker";
import { RemoveImageButton } from "./remove-image-button";

export const metadata: Metadata = { title: "Product" };
export const dynamic = "force-dynamic";

interface ProductImage {
  id: string;
  mediaAssetId: string;
  alt: string | null;
  position: number;
  /** Null while the worker is still processing, or if the file was refused. */
  url: string | null;
}

interface Product {
  id: string;
  name: string;
  brand: string | null;
  sku: string | null;
  status: string;
  description: string | null;
  images: ProductImage[];
  variants: { id: string; sku: string | null; priceCents: number }[];
  category: { id: string; name: string } | null;
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ storeId: string; productId: string }>;
}) {
  const { storeId, productId } = await params;

  let product: Product;
  try {
    product = await api<Product>(`/stores/${storeId}/products/${productId}`, { revalidate: false });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const price = product.variants[0]?.priceCents;

  return (
    <div className="mt-8 space-y-6">
      <div>
        <Link
          href={`/store/${storeId}/ops/catalog`}
          className="text-sm text-ink-muted underline underline-offset-4"
        >
          ← Back to catalog
        </Link>
        <h1 className="mt-2 flex flex-wrap items-center gap-3 text-2xl font-semibold text-ink">
          {product.name}
          <StatusBadge status={product.status} />
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {[
            product.brand,
            product.sku && `SKU ${product.sku}`,
            product.category?.name,
            price !== undefined && `$${(price / 100).toFixed(2)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <Card
        title="Photos"
        description="The first photo is the one customers see in listings."
      >
        <div className="space-y-5">
          {product.images.length === 0 ? (
            <EmptyState
              title="No photos yet"
              hint="A product with a photo sells better than one without."
            />
          ) : (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {product.images.map((image, index) => (
                <li key={image.id} className="space-y-2">
                  <div className="relative overflow-hidden rounded-card border border-line bg-surface">
                    {image.url ? (
                      // A plain img, not next/image: these are already resized
                      // to fixed variants by the worker, so a second optimiser
                      // in front of them would re-encode what was re-encoded.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={image.url}
                        alt={image.alt ?? ""}
                        className="aspect-square w-full object-cover"
                      />
                    ) : (
                      <div className="flex aspect-square w-full items-center justify-center px-3 text-center text-sm text-ink-muted">
                        Still processing
                      </div>
                    )}
                    {index === 0 && (
                      <span className="absolute left-2 top-2 rounded-card bg-ink px-2 py-0.5 text-xs text-surface">
                        Main
                      </span>
                    )}
                  </div>
                  <RemoveImageButton
                    storeId={storeId}
                    productId={productId}
                    imageId={image.id}
                  />
                </li>
              ))}
            </ul>
          )}

          <ImagePicker storeId={storeId} productId={productId} />
        </div>
      </Card>
    </div>
  );
}
