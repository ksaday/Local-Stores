import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { LocalDiskStorage } from "../../infra/storage/storage.provider.js";
import { testStorage } from "../../infra/storage/test-storage.js";
import { AuditService } from "../audit/audit.service.js";
import { CatalogService } from "../catalog/catalog.service.js";
import { StorefrontService } from "./storefront.service.js";

/**
 * Runs as the RLS-restricted role with no identity, which is exactly what an
 * anonymous storefront request looks like. Against a superuser these would
 * pass while proving nothing about what the public can actually see.
 */
const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const MEDIA_BASE_URL = "http://localhost:3100/media";

const OWNER = "ca000000-0000-4000-8000-000000000001";
const LIVE = "ca000000-0000-4000-8000-00000000000a";
const DRAFT_STORE = "ca000000-0000-4000-8000-00000000000b";

let prisma: PrismaService;
let storefront: StorefrontService;
let catalog: CatalogService;

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  storefront = new StorefrontService(prisma, new LocalDiskStorage(testStorage(".storage", MEDIA_BASE_URL)));
  catalog = new CatalogService(prisma, new AuditService(prisma));
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await seed();
});

async function asAdmin<T>(work: (admin: PrismaService) => Promise<T>): Promise<T> {
  const admin = new PrismaService();
  try {
    return await work(admin);
  } finally {
    await admin.$disconnect();
  }
}

async function seed(): Promise<void> {
  await asAdmin(async (admin) => {
    await admin.$executeRaw`
      INSERT INTO users (id,email,name,status,created_at,updated_at)
      VALUES (${OWNER},'store-front@example.com'::citext,'Owner','ACTIVE',now(),now())`;
    for (const [id, slug, name, status] of [
      [LIVE, "test-morse-ave-bakery", "Morse Ave Bakery", "ACTIVE"],
      [DRAFT_STORE, "test-not-open-yet", "Not Open Yet", "APPROVED"],
    ] as const) {
      await admin.$executeRaw`
        INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,city,state,timezone,
                            currency,branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
        VALUES (${id},${slug}::citext,${name},'RETAIL',${status}::"StoreStatus",${OWNER},
                'Chicago','IL','America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    }
  });
}

/**
 * Inserts a media asset directly. The real pipeline quarantines, sniffs magic
 * bytes and re-encodes; none of that changes what RLS will show the public,
 * which is what these tests are about.
 */
async function addAsset(
  storeId: string,
  opts: { status?: string; isPrivate?: boolean } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await asAdmin(async (admin) => {
    await admin.$executeRaw`
      INSERT INTO media_assets (id,store_id,kind,status,storage_key,mime,bytes,width,height,is_private,created_at,updated_at)
      VALUES (${id},${storeId},'PRODUCT',${opts.status ?? "READY"}::"MediaStatus",
              ${`img/${id}.webp`},'image/webp',1024,800,600,${opts.isPrivate ?? false},now(),now())`;
  });
  return id;
}

async function cleanup(): Promise<void> {
  await asAdmin(async (admin) => {
    const stores = [LIVE, DRAFT_STORE];
    await admin.$executeRaw`DELETE FROM audit_logs WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM product_images WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM media_assets WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM product_variants WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM products WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM categories WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM outbox_events WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM stores WHERE id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
  });
}

/** Creates a product and publishes it, which is what makes it public. */
async function publish(storeId: string, name: string, priceCents: number, brand?: string) {
  const product = await catalog.createProduct(storeId, { name, priceCents, brand });
  return catalog.setProductStatus(storeId, product.id, "ACTIVE");
}

describe("store visibility", () => {
  it("lists a live store in the directory", async () => {
    const stores = await storefront.listStores({});
    expect(stores.map((s) => s.slug)).toContain("test-morse-ave-bakery");
  });

  it("hides a store that isn't live yet", async () => {
    // APPROVED means provisioned but still being set up. A half-built
    // storefront must not be reachable by customers.
    const stores = await storefront.listStores({});
    expect(stores.map((s) => s.slug)).not.toContain("test-not-open-yet");
  });

  it("treats a non-live store as not found rather than forbidden", async () => {
    await expect(storefront.getStore("test-not-open-yet")).rejects.toMatchObject({ status: 404 });
  });

  it("gives the same response for a non-live store and one that never existed", async () => {
    // Otherwise the directory becomes a way to enumerate which businesses have
    // signed up but not launched.
    const hidden = await storefront.getStore("test-not-open-yet").catch((e: AppError) => e);
    const missing = await storefront.getStore("test-no-such-store").catch((e: AppError) => e);

    expect((hidden as AppError).status).toBe((missing as AppError).status);
    expect((hidden as AppError).code).toBe((missing as AppError).code);
  });

  it("finds a store by a misremembered name", async () => {
    // Shoppers misspell and drop words; trigram matching is what makes
    // "morse bakery" find "Morse Ave Bakery".
    const stores = await storefront.listStores({ q: "morse bakery" });
    expect(stores.map((s) => s.slug)).toContain("test-morse-ave-bakery");
  });

  it("does not surface a non-live store through search either", async () => {
    const stores = await storefront.listStores({ q: "not open" });
    expect(stores.map((s) => s.slug)).not.toContain("test-not-open-yet");
  });
});

describe("product visibility", () => {
  it("lists published products", async () => {
    await publish(LIVE, "Sourdough Loaf", 800);
    const { products } = await storefront.listProducts("test-morse-ave-bakery", {});
    expect(products.map((p) => p.name)).toContain("Sourdough Loaf");
  });

  it("hides drafts", async () => {
    // A draft is the owner's work in progress. RLS hides it even from a query
    // that forgot to filter, which is the point of enforcing it in the database.
    await catalog.createProduct(LIVE, { name: "Secret Recipe", priceCents: 500 });
    const { products } = await storefront.listProducts("test-morse-ave-bakery", {});
    expect(products.map((p) => p.name)).not.toContain("Secret Recipe");
  });

  it("hides archived products", async () => {
    const product = await publish(LIVE, "Discontinued Bun", 300);
    await catalog.setProductStatus(LIVE, product.id, "ARCHIVED");

    const { products } = await storefront.listProducts("test-morse-ave-bakery", {});
    expect(products.map((p) => p.name)).not.toContain("Discontinued Bun");
  });

  it("treats a draft product's URL as not found", async () => {
    const product = await catalog.createProduct(LIVE, { name: "Secret Recipe", priceCents: 500 });
    await expect(
      storefront.getProduct("test-morse-ave-bakery", product.slug),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("exposes the default price and variants on the detail page", async () => {
    const product = await publish(LIVE, "Sourdough Loaf", 800);
    await catalog.addVariant(LIVE, product.id, { priceCents: 1400, attrs: { size: "Large" } });

    const { product: detail } = await storefront.getProduct("test-morse-ave-bakery", product.slug);
    expect(detail.variants).toHaveLength(2);
    expect(detail.variants[0]!.isDefault).toBe(true);
    expect(detail.variants[0]!.priceCents).toBe(800);
  });
});

describe("browsing and search", () => {
  beforeEach(async () => {
    await publish(LIVE, "Sourdough Loaf", 800, "Morse Bakehouse");
    await publish(LIVE, "Rye Bread", 650);
    await publish(LIVE, "Almond Croissant", 425);
  });

  it("finds products by full-text search", async () => {
    const { products } = await storefront.listProducts("test-morse-ave-bakery", { q: "sourdough" });
    expect(products.map((p) => p.name)).toEqual(["Sourdough Loaf"]);
  });

  it("searches brand as well as name", async () => {
    const { products } = await storefront.listProducts("test-morse-ave-bakery", { q: "bakehouse" });
    expect(products.map((p) => p.name)).toContain("Sourdough Loaf");
  });

  it("sorts by price ascending and descending", async () => {
    const asc = await storefront.listProducts("test-morse-ave-bakery", { sort: "price_asc" });
    expect(asc.products.map((p) => p.priceCents)).toEqual([425, 650, 800]);

    const desc = await storefront.listProducts("test-morse-ave-bakery", { sort: "price_desc" });
    expect(desc.products.map((p) => p.priceCents)).toEqual([800, 650, 425]);
  });

  it("filters by price range", async () => {
    const { products } = await storefront.listProducts("test-morse-ave-bakery", {
      minCents: 500,
      maxCents: 700,
    });
    expect(products.map((p) => p.name)).toEqual(["Rye Bread"]);
  });

  it("filters by category", async () => {
    const category = await catalog.createCategory(LIVE, { name: "Pastries" });
    const { products: all } = await storefront.listProducts("test-morse-ave-bakery", {});
    const croissant = all.find((p) => p.name === "Almond Croissant")!;
    await catalog.updateProduct(LIVE, croissant.id, { categoryId: category.id });

    const { products } = await storefront.listProducts("test-morse-ave-bakery", {
      categorySlug: "pastries",
    });
    expect(products.map((p) => p.name)).toEqual(["Almond Croissant"]);
  });

  it("reports a total independent of the page size", async () => {
    const { products, total } = await storefront.listProducts("test-morse-ave-bakery", { limit: 2 });
    expect(products).toHaveLength(2);
    expect(total).toBe(3);
  });

  it("reports the full match count when searching, not just the page", async () => {
    // Counting the windowed rows would report 1 here, and the storefront would
    // decide there was no second page of results.
    await publish(LIVE, "Bread Pudding", 500);

    const { products, total } = await storefront.listProducts("test-morse-ave-bakery", {
      q: "bread",
      limit: 1,
    });
    expect(products).toHaveLength(1);
    expect(total).toBe(2);
  });

  it("pages through search results", async () => {
    await publish(LIVE, "Bread Pudding", 500);

    const first = await storefront.listProducts("test-morse-ave-bakery", { q: "bread", limit: 1 });
    const second = await storefront.listProducts("test-morse-ave-bakery", {
      q: "bread",
      limit: 1,
      offset: 1,
    });

    expect(second.products[0]!.id).not.toBe(first.products[0]!.id);
  });

  it("only lists categories that are active", async () => {
    const shown = await catalog.createCategory(LIVE, { name: "Bread" });
    const hidden = await catalog.createCategory(LIVE, { name: "Seasonal" });
    await catalog.updateCategory(LIVE, hidden.id, { active: false });

    const categories = await storefront.listCategories("test-morse-ave-bakery");
    expect(categories.map((c) => c.id)).toEqual([shown.id]);
  });
});

describe("images", () => {
  it("resolves a product image to a public URL", async () => {
    const product = await publish(LIVE, "Sourdough Loaf", 800);
    const assetId = await addAsset(LIVE);
    await catalog.attachImage(LIVE, product.id, { mediaAssetId: assetId, alt: "A round loaf" });

    const { products } = await storefront.listProducts("test-morse-ave-bakery", {});
    expect(products[0]!.image).toMatchObject({
      url: `${MEDIA_BASE_URL}/public/img/${assetId}.webp`,
      alt: "A round loaf",
      width: 800,
      height: 600,
    });
  });

  it("carries images into search results too", async () => {
    const product = await publish(LIVE, "Sourdough Loaf", 800);
    const assetId = await addAsset(LIVE);
    await catalog.attachImage(LIVE, product.id, { mediaAssetId: assetId });

    const { products } = await storefront.listProducts("test-morse-ave-bakery", { q: "sourdough" });
    expect(products[0]!.image?.url).toContain(assetId);
  });

  it("refuses to attach an asset that hasn't finished processing", async () => {
    const product = await publish(LIVE, "Sourdough Loaf", 800);
    const assetId = await addAsset(LIVE, { status: "PENDING" });

    await expect(
      catalog.attachImage(LIVE, product.id, { mediaAssetId: assetId }),
    ).rejects.toThrow();
  });

  it("stops serving an image whose asset is later rejected", async () => {
    // The attach-time check cannot cover this: the asset was READY when it was
    // attached. Only the read policy can pull it back off the page.
    const product = await publish(LIVE, "Sourdough Loaf", 800);
    const assetId = await addAsset(LIVE);
    await catalog.attachImage(LIVE, product.id, { mediaAssetId: assetId });

    await asAdmin((admin) =>
      admin.$executeRaw`UPDATE media_assets SET status = 'REJECTED' WHERE id = ${assetId}`,
    );

    const { products } = await storefront.listProducts("test-morse-ave-bakery", {});
    expect(products[0]!.image).toBeNull();
  });

  it("omits a private asset", async () => {
    // Delivery proofs and signatures are attached to the same store. Marking
    // one private has to be enough to keep it off a public page.
    const product = await publish(LIVE, "Sourdough Loaf", 800);
    const assetId = await addAsset(LIVE, { isPrivate: true });
    await catalog.attachImage(LIVE, product.id, { mediaAssetId: assetId });

    const { products } = await storefront.listProducts("test-morse-ave-bakery", {});
    expect(products[0]!.image).toBeNull();
  });

  it("does not let an anonymous request delete a public asset", async () => {
    // The policy was split into read and write precisely for this: a FOR ALL
    // policy with a public branch in USING makes public rows deletable.
    const assetId = await addAsset(LIVE);

    const deleted = await prisma.withTenant({ isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`DELETE FROM media_assets WHERE id = ${assetId}`,
    );
    expect(deleted).toBe(0);
  });
});

describe("sitemap", () => {
  it("includes only publicly visible stores and products", async () => {
    await publish(LIVE, "Sourdough Loaf", 800);
    await catalog.createProduct(LIVE, { name: "Draft Item", priceCents: 100 });

    const { stores, products } = await storefront.sitemapEntries();
    expect(stores.map((s) => s.slug)).toContain("test-morse-ave-bakery");
    expect(stores.map((s) => s.slug)).not.toContain("test-not-open-yet");
    expect(products.map((p) => p.slug)).toContain("sourdough-loaf");
    expect(products.map((p) => p.slug)).not.toContain("draft-item");
  });
});
