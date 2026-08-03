import { Injectable } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { StorageProvider } from "../../infra/storage/storage.provider.js";

export interface DirectoryFilters {
  q?: string;
  businessType?: "RETAIL" | "RESTAURANT" | "SERVICE";
  limit?: number;
}

export interface ProductFilters {
  q?: string;
  categorySlug?: string;
  minCents?: number;
  maxCents?: number;
  sort?: "relevance" | "price_asc" | "price_desc" | "newest";
  limit?: number;
  offset?: number;
}

/**
 * Public, unauthenticated reads for the storefront and directory.
 *
 * Every query here runs with **no identity context**. That is deliberate:
 * RLS already restricts public visibility to ACTIVE products in ACTIVE stores,
 * so a draft product or a suspended store is invisible even if a query here
 * forgot to filter for it. The service adds filters for correctness and
 * ordering, not for security — the database is the guarantee.
 */
@Injectable()
export class StorefrontService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
  ) {}

  /** Anonymous scope: no user, no store, no platform role. */
  private publicScope() {
    return { isSuperAdmin: false } as const;
  }

  /**
   * Resolves media asset ids to public URLs.
   *
   * Runs in the same anonymous scope as everything else, so RLS decides what
   * resolves: an asset that is private, still in quarantine, or belongs to a
   * store that is not live simply comes back missing and the caller renders a
   * placeholder. An id that fails to resolve is not an error — it is a picture
   * the public was never entitled to see.
   */
  private async resolveMedia(ids: string[]): Promise<Map<string, MediaRef>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();

    const assets = await this.prisma.withTenant(this.publicScope(), (tx) =>
      tx.mediaAsset.findMany({
        where: { id: { in: unique } },
        select: { id: true, storageKey: true, width: true, height: true },
      }),
    );

    return new Map(
      assets.map((a) => [
        a.id,
        { url: this.storage.publicVariantUrl(a.storageKey), width: a.width, height: a.height },
      ]),
    );
  }

  async listStores(filters: DirectoryFilters) {
    const limit = Math.min(filters.limit ?? 50, 100);

    if (filters.q?.trim()) {
      // Trigram similarity rather than an exact prefix: shoppers misremember
      // and misspell shop names, and "morse bakery" should find
      // "Morse Ave Bakery".
      //
      // The business-type filter is applied as a parameter that matches
      // everything when absent, rather than by splicing a clause into the SQL —
      // conditional string building is how injection gets in.
      const q = filters.q.trim();
      const typeFilter = filters.businessType ?? null;

      const rows = await this.prisma.withTenant(this.publicScope(), (tx) => tx.$queryRaw<
        RawStoreRow[]
      >`
        SELECT id, slug, name, business_type::text AS business_type, city, state,
               branding, similarity(name, ${q}) AS score
        FROM stores
        WHERE status = 'ACTIVE'
          AND deleted_at IS NULL
          AND (name % ${q} OR name ILIKE ${"%" + q + "%"})
          AND (${typeFilter}::text IS NULL OR business_type::text = ${typeFilter}::text)
        ORDER BY score DESC, name ASC
        LIMIT ${limit}
      `);

      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        businessType: r.business_type,
        city: r.city,
        state: r.state,
        branding: r.branding,
      }));
    }

    return this.prisma.withTenant(this.publicScope(), (tx) =>
      tx.store.findMany({
        where: {
          status: "ACTIVE",
          deletedAt: null,
          ...(filters.businessType ? { businessType: filters.businessType } : {}),
        },
        select: {
          id: true, slug: true, name: true, businessType: true,
          city: true, state: true, branding: true,
        },
        orderBy: { name: "asc" },
        take: limit,
      }),
    );
  }

  async getStore(slug: string) {
    const store = await this.prisma.withTenant(this.publicScope(), (tx) =>
      tx.store.findFirst({
        where: { slug, status: "ACTIVE", deletedAt: null },
        select: {
          id: true, slug: true, name: true, businessType: true,
          addressLine1: true, city: true, state: true, postalCode: true,
          timezone: true, currency: true, branding: true, cashEnabled: true,
          hours: { orderBy: { weekday: "asc" } },
        },
      }),
    );
    // A suspended or draft store is indistinguishable from one that never
    // existed — the same non-enumeration property the rest of the API keeps.
    if (!store) throw AppError.notFound();

    // The logo and banner are stored in `branding` as asset ids. Resolving
    // them here means a storefront page never has to know that media lives
    // behind a separate table.
    const branding = (store.branding ?? {}) as {
      logoAssetId?: string;
      bannerAssetId?: string;
    };
    const media = await this.resolveMedia([
      branding.logoAssetId ?? "",
      branding.bannerAssetId ?? "",
    ]);

    return {
      ...store,
      logo: branding.logoAssetId ? (media.get(branding.logoAssetId) ?? null) : null,
      banner: branding.bannerAssetId ? (media.get(branding.bannerAssetId) ?? null) : null,
    };
  }

  async listCategories(storeSlug: string) {
    const store = await this.getStore(storeSlug);

    const rows = await this.prisma.withTenant(this.publicScope(), (tx) =>
      tx.category.findMany({
        where: { storeId: store.id, active: true, deletedAt: null },
        select: { id: true, name: true, slug: true, parentId: true, position: true },
        orderBy: [{ position: "asc" }, { name: "asc" }],
      }),
    );

    return rows
      .filter((c) => !c.parentId)
      .map((root) => ({ ...root, children: rows.filter((c) => c.parentId === root.id) }));
  }

  async listProducts(storeSlug: string, filters: ProductFilters) {
    const store = await this.getStore(storeSlug);
    const limit = Math.min(filters.limit ?? 24, 60);
    const offset = Math.max(filters.offset ?? 0, 0);

    // Full-text search is a raw query because Prisma cannot express tsvector
    // ranking. Everything is parameterised — the sort key is chosen from a
    // fixed set below rather than interpolated from input.
    if (filters.q?.trim()) {
      const q = filters.q.trim();
      const rows = await this.prisma.withTenant(this.publicScope(), (tx) => tx.$queryRaw<
        RawProductRow[]
      >`
        SELECT p.id, p.name, p.slug, p.brand, p.description,
               c.name AS category_name, c.slug AS category_slug,
               v.price_cents, v.compare_at_cents,
               ts_rank(p.search, websearch_to_tsquery('english', ${q})) AS rank
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        JOIN product_variants v ON v.product_id = p.id AND v.is_default AND v.deleted_at IS NULL
        WHERE p.store_id = ${store.id}
          AND p.status = 'ACTIVE'
          AND p.deleted_at IS NULL
          AND (p.search @@ websearch_to_tsquery('english', ${q}) OR p.name % ${q})
        ORDER BY rank DESC, p.name ASC
        LIMIT ${limit} OFFSET ${offset}
      `);

      // The count has to be a separate query: the ranking query is windowed by
      // LIMIT/OFFSET, so counting its rows would report the page size and
      // pagination would stop after the first page.
      const [{ count }] = await this.prisma.withTenant(this.publicScope(), (tx) => tx.$queryRaw<
        [{ count: bigint }]
      >`
        SELECT count(*) AS count
        FROM products p
        WHERE p.store_id = ${store.id}
          AND p.status = 'ACTIVE'
          AND p.deleted_at IS NULL
          AND (p.search @@ websearch_to_tsquery('english', ${q}) OR p.name % ${q})
      `);

      // Search results get the same images as browse results. Fetched
      // separately rather than as a lateral join so the ranking query stays
      // readable, and because this is one extra indexed lookup per page.
      const covers = await this.prisma.withTenant(this.publicScope(), (tx) =>
        tx.productImage.findMany({
          where: { productId: { in: rows.map((r) => r.id) }, position: 0 },
          select: { productId: true, mediaAssetId: true, alt: true },
        }),
      );
      const media = await this.resolveMedia(covers.map((c) => c.mediaAssetId));
      const byProduct = new Map(covers.map((c) => [c.productId, c]));

      return {
        store,
        products: rows.map((r) => ({
          ...toProduct(r),
          image: toImage(byProduct.get(r.id), media),
        })),
        total: Number(count),
      };
    }

    const where = {
      storeId: store.id,
      status: "ACTIVE" as const,
      deletedAt: null,
      ...(filters.categorySlug ? { category: { slug: filters.categorySlug } } : {}),
      ...(filters.minCents !== undefined || filters.maxCents !== undefined
        ? {
            variants: {
              some: {
                isDefault: true,
                deletedAt: null,
                priceCents: {
                  ...(filters.minCents !== undefined ? { gte: filters.minCents } : {}),
                  ...(filters.maxCents !== undefined ? { lte: filters.maxCents } : {}),
                },
              },
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.withTenant(this.publicScope(), async (tx) => [
      await tx.product.findMany({
        where,
        select: {
          id: true, name: true, slug: true, brand: true, description: true,
          category: { select: { name: true, slug: true } },
          variants: {
            where: { isDefault: true, deletedAt: null },
            select: { priceCents: true, compareAtCents: true },
          },
          images: { orderBy: { position: "asc" }, take: 1, select: { mediaAssetId: true, alt: true } },
        },
        orderBy:
          filters.sort === "newest"
            ? { createdAt: "desc" }
            : { name: "asc" },
        take: limit,
        skip: offset,
      }),
      await tx.product.count({ where }),
    ]);

    const media = await this.resolveMedia(rows.map((r) => r.images[0]?.mediaAssetId ?? ""));

    let products = rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      brand: r.brand,
      description: r.description,
      category: r.category,
      priceCents: r.variants[0]?.priceCents ?? 0,
      compareAtCents: r.variants[0]?.compareAtCents ?? null,
      image: toImage(r.images[0], media),
    }));

    // Price sorting happens here rather than in SQL because the price lives on
    // the default variant, and ordering a parent by a filtered child is not
    // expressible in Prisma. Bounded by `limit`, so this sorts a page, not a
    // catalogue — revisit if page sizes ever grow.
    if (filters.sort === "price_asc") products = products.sort((a, b) => a.priceCents - b.priceCents);
    if (filters.sort === "price_desc") products = products.sort((a, b) => b.priceCents - a.priceCents);

    return { store, products, total };
  }

  async getProduct(storeSlug: string, productSlug: string) {
    const store = await this.getStore(storeSlug);

    const product = await this.prisma.withTenant(this.publicScope(), (tx) =>
      tx.product.findFirst({
        where: { storeId: store.id, slug: productSlug, status: "ACTIVE", deletedAt: null },
        select: {
          id: true, name: true, slug: true, brand: true, description: true,
          category: { select: { name: true, slug: true } },
          variants: {
            where: { deletedAt: null, active: true },
            select: {
              id: true, sku: true, attrs: true, priceCents: true,
              compareAtCents: true, isDefault: true,
            },
            orderBy: { isDefault: "desc" },
          },
          images: { orderBy: { position: "asc" }, select: { mediaAssetId: true, alt: true } },
        },
      }),
    );
    if (!product) throw AppError.notFound();

    const media = await this.resolveMedia(product.images.map((i) => i.mediaAssetId));

    return {
      store,
      product: {
        ...product,
        images: product.images
          .map((i) => toImage(i, media))
          .filter((i): i is StorefrontImage => i !== null),
      },
    };
  }

  /** Slugs of every publicly visible store and product, for sitemap generation. */
  async sitemapEntries() {
    return this.prisma.withTenant(this.publicScope(), async (tx) => {
      const stores = await tx.store.findMany({
        where: { status: "ACTIVE", deletedAt: null },
        select: { slug: true, updatedAt: true },
      });
      const products = await tx.product.findMany({
        where: { status: "ACTIVE", deletedAt: null },
        select: { slug: true, updatedAt: true, store: { select: { slug: true } } },
        take: 5000,
      });
      return { stores, products };
    });
  }
}

export interface MediaRef {
  url: string;
  width: number | null;
  height: number | null;
}

export interface StorefrontImage extends MediaRef {
  alt: string | null;
}

/**
 * Pairs an image row with its resolved asset. Returns null when the asset did
 * not resolve, so an image the public cannot see is absent rather than a
 * broken `<img>`.
 */
function toImage(
  row: { mediaAssetId: string; alt: string | null } | undefined,
  media: Map<string, MediaRef>,
): StorefrontImage | null {
  if (!row) return null;
  const asset = media.get(row.mediaAssetId);
  return asset ? { ...asset, alt: row.alt } : null;
}

interface RawStoreRow {
  id: string;
  slug: string;
  name: string;
  business_type: string;
  city: string | null;
  state: string | null;
  branding: unknown;
}

interface RawProductRow {
  id: string;
  name: string;
  slug: string;
  brand: string | null;
  description: string | null;
  category_name: string | null;
  category_slug: string | null;
  price_cents: number;
  compare_at_cents: number | null;
}

function toProduct(row: RawProductRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    brand: row.brand,
    description: row.description,
    category: row.category_slug ? { name: row.category_name!, slug: row.category_slug } : null,
    priceCents: Number(row.price_cents),
    compareAtCents: row.compare_at_cents === null ? null : Number(row.compare_at_cents),
  };
}
