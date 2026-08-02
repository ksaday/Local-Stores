import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { CatalogService } from "./catalog.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const OWNER = "c9000000-0000-4000-8000-000000000001";
const STORE = "c9000000-0000-4000-8000-00000000000a";
const OTHER_STORE = "c9000000-0000-4000-8000-00000000000b";

let prisma: PrismaService;
let catalog: CatalogService;

beforeAll(async () => {
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
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
      VALUES (${OWNER},'catalog-owner@example.com'::citext,'Owner','ACTIVE',now(),now())`;
    for (const [id, slug] of [[STORE, "catalog-store"], [OTHER_STORE, "catalog-other"]] as const) {
      await admin.$executeRaw`
        INSERT INTO stores (id,slug,name,business_type,status,owner_user_id,timezone,currency,
                            branding,cash_enabled,stripe_charges_enabled,platform_fee_bps,created_at,updated_at)
        VALUES (${id},${slug}::citext,'Catalog Store','RETAIL','ACTIVE',${OWNER},
                'America/Chicago','USD','{}'::jsonb,true,false,0,now(),now())`;
    }
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (admin) => {
    const stores = [STORE, OTHER_STORE];
    await admin.$executeRaw`DELETE FROM audit_logs WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM product_images WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM product_variants WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM products WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM categories WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM media_assets WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM outbox_events WHERE store_id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM stores WHERE id = ANY(${stores})`;
    await admin.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
  });
}

async function expectRejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("Expected the call to reject, but it resolved.");
}

const baseProduct = { name: "Sourdough Loaf", priceCents: 800 };

describe("categories", () => {
  it("creates a category with a derived slug", async () => {
    const created = await catalog.createCategory(STORE, { name: "Fresh Bread" });
    expect(created.slug).toBe("fresh-bread");
  });

  it("allows one level of nesting", async () => {
    const parent = await catalog.createCategory(STORE, { name: "Bread" });
    const child = await catalog.createCategory(STORE, { name: "Sourdough", parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  it("refuses a third level", async () => {
    // Deeper trees multiply the navigation an owner has to maintain, and the
    // storefront is not written to render them.
    const parent = await catalog.createCategory(STORE, { name: "Bread" });
    const child = await catalog.createCategory(STORE, { name: "Sourdough", parentId: parent.id });

    await expect(
      catalog.createCategory(STORE, { name: "Rye", parentId: child.id }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("returns categories as a tree", async () => {
    const parent = await catalog.createCategory(STORE, { name: "Bread" });
    await catalog.createCategory(STORE, { name: "Sourdough", parentId: parent.id });

    const tree = await catalog.listCategories(STORE);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(1);
  });

  it("rejects a duplicate name in the same store", async () => {
    await catalog.createCategory(STORE, { name: "Bread" });
    await expect(catalog.createCategory(STORE, { name: "Bread" })).rejects.toBeInstanceOf(AppError);
  });

  it("allows the same name in a different store", async () => {
    await catalog.createCategory(STORE, { name: "Bread" });
    await expect(catalog.createCategory(OTHER_STORE, { name: "Bread" })).resolves.toBeDefined();
  });

  it("refuses to delete a category that still has subcategories", async () => {
    const parent = await catalog.createCategory(STORE, { name: "Bread" });
    await catalog.createCategory(STORE, { name: "Sourdough", parentId: parent.id });

    await expect(catalog.deleteCategory(STORE, parent.id)).rejects.toBeInstanceOf(AppError);
  });
});

describe("products", () => {
  it("creates a default variant alongside the product", async () => {
    // A product with no variant has no price and cannot be bought, so the
    // default is created here rather than left as a step to remember.
    const product = await catalog.createProduct(STORE, baseProduct);

    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]!.isDefault).toBe(true);
    expect(product.variants[0]!.priceCents).toBe(800);
  });

  it("starts as a draft", async () => {
    const product = await catalog.createProduct(STORE, baseProduct);
    expect(product.status).toBe("DRAFT");
  });

  it("disambiguates a slug when two products share a name", async () => {
    const first = await catalog.createProduct(STORE, baseProduct);
    const second = await catalog.createProduct(STORE, baseProduct);

    expect(first.slug).toBe("sourdough-loaf");
    expect(second.slug).toBe("sourdough-loaf-2");
  });

  it("publishes a priced product", async () => {
    const product = await catalog.createProduct(STORE, baseProduct);
    const published = await catalog.setProductStatus(STORE, product.id, "ACTIVE");
    expect(published.status).toBe("ACTIVE");
  });

  it("refuses to publish a product with no price", async () => {
    // A live product with no price is a customer-facing bug the storefront
    // has no sensible way to render.
    const product = await catalog.createProduct(STORE, { name: "Mystery Box", priceCents: 0 });
    const err = await expectRejection(catalog.setProductStatus(STORE, product.id, "ACTIVE"));
    expect(err.message).toMatch(/price/i);
  });

  it("soft-deletes rather than removing the row", async () => {
    const product = await catalog.createProduct(STORE, baseProduct);
    await catalog.deleteProduct(STORE, product.id);

    await expect(catalog.getProduct(STORE, product.id)).rejects.toBeInstanceOf(AppError);

    // Still present for order history to point at.
    const row = await asAdmin((a) => a.product.findUnique({ where: { id: product.id } }));
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it("treats another store's product as not found", async () => {
    const product = await catalog.createProduct(OTHER_STORE, baseProduct);
    await expect(catalog.getProduct(STORE, product.id)).rejects.toMatchObject({ status: 404 });
  });

  it("frees a SKU once its product is deleted", async () => {
    const first = await catalog.createProduct(STORE, { ...baseProduct, sku: "SD-001" });
    await catalog.deleteProduct(STORE, first.id);

    // The partial unique index excludes deleted rows, so the SKU is reusable.
    await expect(
      catalog.createProduct(STORE, { ...baseProduct, sku: "SD-001" }),
    ).resolves.toBeDefined();
  });
});

describe("variants", () => {
  it("rejects a duplicate SKU within a store", async () => {
    const product = await catalog.createProduct(STORE, { ...baseProduct, sku: "SD-001" });
    const err = await expectRejection(
      catalog.addVariant(STORE, product.id, { priceCents: 900, sku: "SD-001" }),
    );
    expect(err.fieldErrors?.[0]?.code).toBe("DUPLICATE");
  });

  it("allows the same SKU in a different store", async () => {
    // SKUs are a store's own numbering; two shops may both call something A-1.
    await catalog.createProduct(STORE, { ...baseProduct, sku: "A-1" });
    await expect(
      catalog.createProduct(OTHER_STORE, { ...baseProduct, sku: "A-1" }),
    ).resolves.toBeDefined();
  });

  it("keeps exactly one default when variants are added", async () => {
    const product = await catalog.createProduct(STORE, baseProduct);
    await catalog.addVariant(STORE, product.id, { priceCents: 1200, attrs: { size: "Large" } });

    const refreshed = await catalog.getProduct(STORE, product.id);
    expect(refreshed.variants.filter((v) => v.isDefault)).toHaveLength(1);
  });

  it("refuses to delete the last variant", async () => {
    const product = await catalog.createProduct(STORE, baseProduct);
    await expect(
      catalog.deleteVariant(STORE, product.variants[0]!.id),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("promotes a survivor when the default is deleted", async () => {
    // Something must carry "the price" or the storefront has nothing to show.
    const product = await catalog.createProduct(STORE, baseProduct);
    const second = await catalog.addVariant(STORE, product.id, { priceCents: 1200 });

    await catalog.deleteVariant(STORE, product.variants[0]!.id);

    const refreshed = await catalog.getProduct(STORE, product.id);
    expect(refreshed.variants).toHaveLength(1);
    expect(refreshed.variants[0]!.id).toBe(second.id);
    expect(refreshed.variants[0]!.isDefault).toBe(true);
  });
});

describe("images", () => {
  async function readyAsset(storeId: string): Promise<string> {
    const id = randomUUID();
    await asAdmin((a) => a.$executeRaw`
      INSERT INTO media_assets (id,store_id,kind,status,storage_key,mime,bytes,is_private,created_at,updated_at)
      VALUES (${id},${storeId},'PRODUCT'::"MediaKind",'READY'::"MediaStatus",
              ${"product/" + id},'image/webp',1024,false,now(),now())`);
    return id;
  }

  it("attaches a processed image and assigns the next position", async () => {
    const product = await catalog.createProduct(STORE, baseProduct);
    const first = await catalog.attachImage(STORE, product.id, {
      mediaAssetId: await readyAsset(STORE),
    });
    const second = await catalog.attachImage(STORE, product.id, {
      mediaAssetId: await readyAsset(STORE),
    });

    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
  });

  it("refuses an asset that hasn't been processed", async () => {
    // A PENDING asset has not been validated or re-encoded; a REJECTED one
    // never will be. Neither belongs on a storefront.
    const product = await catalog.createProduct(STORE, baseProduct);
    const pendingId = randomUUID();
    await asAdmin((a) => a.$executeRaw`
      INSERT INTO media_assets (id,store_id,kind,status,storage_key,mime,bytes,is_private,created_at,updated_at)
      VALUES (${pendingId},${STORE},'PRODUCT'::"MediaKind",'PENDING'::"MediaStatus",
              ${"product/" + pendingId},'image/png',1024,false,now(),now())`);

    await expect(
      catalog.attachImage(STORE, product.id, { mediaAssetId: pendingId }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("reorders without colliding on the position constraint", async () => {
    const product = await catalog.createProduct(STORE, baseProduct);
    const a = await catalog.attachImage(STORE, product.id, { mediaAssetId: await readyAsset(STORE) });
    const b = await catalog.attachImage(STORE, product.id, { mediaAssetId: await readyAsset(STORE) });
    const c = await catalog.attachImage(STORE, product.id, { mediaAssetId: await readyAsset(STORE) });

    await catalog.reorderImages(STORE, product.id, [c.id, a.id, b.id]);

    const refreshed = await catalog.getProduct(STORE, product.id);
    expect(refreshed.images.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
  });
});
