import { api } from "./api";
import type { StorefrontImage, StoreThemeColors } from "@/components/storefront";

/**
 * Storefront reads.
 *
 * All of these go through `api()` with `authenticated: false`, which is doing
 * real work: it withholds the session cookie, so a signed-in shopper gets
 * byte-identical HTML to a stranger. That is what makes these pages safe to
 * cache and share — a personalised response leaking into a shared cache is how
 * one customer ends up seeing another's data.
 */

/** How long a storefront page may serve stale before revalidating. */
const STOREFRONT_TTL = 60;

export interface PublicStore {
  id: string;
  slug: string;
  name: string;
  businessType: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  timezone: string;
  currency: string;
  cashEnabled: boolean;
  branding: { theme?: StoreThemeColors } | null;
  logo: StorefrontImage | null;
  banner: StorefrontImage | null;
  hours: { weekday: number; opens: string | null; closes: string | null; isClosed: boolean }[];
}

export interface PublicProduct {
  id: string;
  name: string;
  slug: string;
  brand: string | null;
  description: string | null;
  category: { name: string; slug: string } | null;
  priceCents: number;
  compareAtCents: number | null;
  image: StorefrontImage | null;
}

export interface PublicProductDetail extends Omit<PublicProduct, "image"> {
  images: StorefrontImage[];
  variants: {
    id: string;
    sku: string | null;
    attrs: Record<string, string>;
    priceCents: number;
    compareAtCents: number | null;
    isDefault: boolean;
  }[];
}

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  children: { id: string; name: string; slug: string }[];
}

/** Cache tag for everything belonging to one store, so a catalog edit can
 *  revalidate that store's pages without flushing the whole site. */
export function storeTag(slug: string): string {
  return `store:${slug}`;
}

export async function listStores(params: { q?: string; businessType?: string } = {}) {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.businessType) query.set("businessType", params.businessType);

  return api<
    {
      id: string;
      slug: string;
      name: string;
      businessType: string;
      city: string | null;
      state: string | null;
      branding: { theme?: StoreThemeColors } | null;
    }[]
  >(`/public/stores?${query}`, {
    authenticated: false,
    // A search is a different response per query string; caching every typo
    // shoppers produce would fill the cache with single-use entries.
    revalidate: params.q ? 0 : STOREFRONT_TTL,
    tags: ["stores"],
  });
}

export async function getStore(slug: string): Promise<PublicStore> {
  return api<PublicStore>(`/public/stores/${encodeURIComponent(slug)}`, {
    authenticated: false,
    revalidate: STOREFRONT_TTL,
    tags: [storeTag(slug)],
  });
}

export async function listCategories(slug: string): Promise<PublicCategory[]> {
  return api<PublicCategory[]>(`/public/stores/${encodeURIComponent(slug)}/categories`, {
    authenticated: false,
    revalidate: STOREFRONT_TTL,
    tags: [storeTag(slug)],
  });
}

export async function listProducts(
  slug: string,
  params: {
    q?: string;
    categorySlug?: string;
    sort?: string;
    minCents?: number;
    maxCents?: number;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ store: PublicStore; products: PublicProduct[]; total: number }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    // The API names the category filter `category`; everything else matches.
    query.set(key === "categorySlug" ? "category" : key, String(value));
  }

  return api(`/public/stores/${encodeURIComponent(slug)}/products?${query}`, {
    authenticated: false,
    revalidate: params.q ? 0 : STOREFRONT_TTL,
    tags: [storeTag(slug)],
  });
}

export async function getProduct(
  slug: string,
  productSlug: string,
): Promise<{ store: PublicStore; product: PublicProductDetail }> {
  return api(
    `/public/stores/${encodeURIComponent(slug)}/products/${encodeURIComponent(productSlug)}`,
    { authenticated: false, revalidate: STOREFRONT_TTL, tags: [storeTag(slug)] },
  );
}

export async function sitemapEntries() {
  return api<{
    stores: { slug: string; updatedAt: string }[];
    products: { slug: string; updatedAt: string; store: { slug: string } }[];
  }>("/public/sitemap-entries", {
    authenticated: false,
    revalidate: 3600,
    tags: ["stores"],
  });
}

// ── Cart and checkout ──────────────────────────────────────────────────────

export interface CartLine {
  id: string;
  variantId: string;
  qty: number;
  productName: string;
  productSlug: string;
  variantAttrs: Record<string, string>;
  unitPriceCents: number;
  lineTotalCents: number;
  problem:
    | { kind: "unavailable"; detail: string }
    | { kind: "price_changed"; wasCents: number; nowCents: number }
    | { kind: "insufficient_stock"; availableQty: number }
    | null;
}

export interface CartView {
  id: string | null;
  storeId: string;
  lines: CartLine[];
  subtotalCents: number;
  itemCount: number;
}

export interface Quote {
  lines: { productName: string; qty: number; lineTotalCents: number }[];
  subtotalCents: number;
  taxCents: number;
  taxDescription: string;
  deliveryFeeCents: number;
  tipCents: number;
  totalCents: number;
  currency: string;
  deliveryProblem: string | null;
  etaMinutes: number | null;
}

/**
 * Cart reads are per-shopper, so they must never be cached: the cookie that
 * identifies the cart is forwarded, and a shared cache entry would hand one
 * shopper another's basket.
 */
export async function getCart(storeId: string): Promise<CartView> {
  return api<CartView>(`/stores/${storeId}/cart`, { authenticated: true, revalidate: false });
}
