import type { MetadataRoute } from "next";
import { sitemapEntries } from "@/lib/storefront";

const SITE_URL = process.env.WEB_ORIGIN ?? "http://localhost:3100";

/**
 * Only publicly visible stores and products appear here — the API derives the
 * list under the same RLS policies that serve the pages, so a draft product
 * cannot leak into the sitemap even though nobody is looking at this output.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { stores, products } = await sitemapEntries();

  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/stores`, changeFrequency: "daily", priority: 0.9 },
    ...stores.map((s) => ({
      url: `${SITE_URL}/stores/${s.slug}`,
      lastModified: new Date(s.updatedAt),
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
    ...products.map((p) => ({
      url: `${SITE_URL}/stores/${p.store.slug}/products/${p.slug}`,
      lastModified: new Date(p.updatedAt),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
