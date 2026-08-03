import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { StorageProvider } from "../../infra/storage/storage.provider.js";
import { AuditService } from "../audit/audit.service.js";

export type ProductStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

export interface VariantInput {
  sku?: string | null;
  barcode?: string | null;
  attrs?: Record<string, string>;
  priceCents: number;
  compareAtCents?: number | null;
  costCents?: number | null;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageProvider,
  ) {}

  /**
   * Turns image rows into something renderable.
   *
   * The row holds an asset id; the URL is built from the asset's storage key,
   * which is the storage layer's business and not a column anyone should be
   * copying around. Assets that are still PENDING or were REJECTED resolve to
   * nothing, so an image that cannot be displayed is absent rather than a
   * broken one.
   */
  private async withImageUrls<T extends { images: { mediaAssetId: string }[] }>(
    storeId: string,
    rows: T[],
  ): Promise<(T & { images: (T["images"][number] & { url: string | null })[] })[]> {
    const ids = [...new Set(rows.flatMap((r) => r.images.map((i) => i.mediaAssetId)))];
    if (ids.length === 0) return rows as never;

    const assets = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.mediaAsset.findMany({
        where: { id: { in: ids }, status: "READY" },
        select: { id: true, storageKey: true },
      }),
    );
    const urls = new Map(assets.map((a) => [a.id, this.storage.publicVariantUrl(a.storageKey)]));

    return rows.map((row) => ({
      ...row,
      images: row.images.map((image) => ({ ...image, url: urls.get(image.mediaAssetId) ?? null })),
    })) as never;
  }

  // ── Categories ───────────────────────────────────────────────────────────

  async listCategories(storeId: string) {
    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.category.findMany({
        where: { storeId, deletedAt: null },
        orderBy: [{ position: "asc" }, { name: "asc" }],
      }),
    );

    // Returned as a tree rather than a flat list: the storefront and the editor
    // both render nesting, and rebuilding it in two places invites them to
    // disagree about ordering.
    const roots = rows.filter((c) => !c.parentId);
    return roots.map((root) => ({
      ...root,
      children: rows.filter((c) => c.parentId === root.id),
    }));
  }

  async createCategory(
    storeId: string,
    input: { name: string; parentId?: string | null; position?: number },
  ) {
    const slug = slugify(input.name);
    await this.assertCategorySlugFree(storeId, slug);

    if (input.parentId) {
      // Checked here for a clear error; the database trigger is the backstop
      // that an import or a manual fix cannot get around.
      const parent = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
        tx.category.findFirst({ where: { id: input.parentId!, storeId, deletedAt: null } }),
      );
      if (!parent) throw AppError.notFound("That parent category doesn't exist.");
      if (parent.parentId) {
        throw AppError.validation(
          "Categories can only be one level deep. Pick a top-level category as the parent.",
        );
      }
    }

    const created = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.category.create({
        data: {
          storeId,
          name: input.name.trim(),
          slug,
          parentId: input.parentId ?? null,
          position: input.position ?? 0,
        },
      }),
    );

    await this.audit.record({
      action: "catalog.category_created",
      entityType: "category",
      entityId: created.id,
      severity: "LOW",
      storeId,
      after: { name: created.name, slug: created.slug },
    });

    return created;
  }

  async updateCategory(
    storeId: string,
    categoryId: string,
    patch: { name?: string; position?: number; active?: boolean },
  ) {
    await this.requireCategory(storeId, categoryId);

    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.category.update({
        where: { id: categoryId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.position !== undefined ? { position: patch.position } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
        },
      }),
    );
  }

  /**
   * Soft delete. Products keep their category reference rather than being
   * silently uncategorised — restoring a category that was removed by mistake
   * should not require re-filing every product that was in it.
   */
  async deleteCategory(storeId: string, categoryId: string): Promise<void> {
    await this.requireCategory(storeId, categoryId);

    const childCount = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.category.count({ where: { parentId: categoryId, deletedAt: null } }),
    );
    if (childCount > 0) {
      throw AppError.validation(
        "Remove or move the subcategories first, otherwise they'd be orphaned.",
      );
    }

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.category.update({ where: { id: categoryId }, data: { deletedAt: new Date() } }),
    );

    await this.audit.record({
      action: "catalog.category_deleted",
      entityType: "category",
      entityId: categoryId,
      severity: "LOW",
      storeId,
    });
  }

  // ── Products ─────────────────────────────────────────────────────────────

  async listProducts(
    storeId: string,
    filters: { status?: ProductStatus; categoryId?: string; q?: string } = {},
  ) {
    const products = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.product.findMany({
        where: {
          storeId,
          deletedAt: null,
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
          ...(filters.q
            ? {
                OR: [
                  { name: { contains: filters.q, mode: "insensitive" } },
                  { brand: { contains: filters.q, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        include: {
          variants: { where: { deletedAt: null }, orderBy: { isDefault: "desc" } },
          images: { orderBy: { position: "asc" }, take: 1 },
          category: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 200,
      }),
    );
    return this.withImageUrls(storeId, products);
  }

  async getProduct(storeId: string, productId: string) {
    const product = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.product.findFirst({
        where: { id: productId, storeId, deletedAt: null },
        include: {
          variants: { where: { deletedAt: null }, orderBy: { isDefault: "desc" } },
          images: { orderBy: { position: "asc" } },
          category: { select: { id: true, name: true } },
        },
      }),
    );
    if (!product) throw AppError.notFound();
    const [withUrls] = await this.withImageUrls(storeId, [product]);
    return withUrls!;
  }

  /**
   * Create a product together with its first variant.
   *
   * A product with no variant has no price and cannot be bought, so the
   * default is created here rather than left as a second step the owner has to
   * remember (FR-CAT-03). Products start as DRAFT — nothing reaches a customer
   * until someone deliberately publishes it.
   */
  async createProduct(
    storeId: string,
    input: {
      name: string;
      brand?: string;
      description?: string;
      categoryId?: string | null;
      priceCents: number;
      sku?: string | null;
    },
  ) {
    const slug = await this.uniqueProductSlug(storeId, input.name);
    if (input.sku) await this.assertSkuFree(storeId, input.sku);

    const productId = randomUUID();

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      await tx.product.create({
        data: {
          id: productId,
          storeId,
          categoryId: input.categoryId ?? null,
          name: input.name.trim(),
          slug,
          brand: input.brand?.trim() || null,
          description: input.description?.trim() || null,
          status: "DRAFT",
        },
      });

      await tx.productVariant.create({
        data: {
          productId,
          storeId,
          sku: input.sku?.trim() || null,
          priceCents: input.priceCents,
          isDefault: true,
        },
      });
    });

    await this.audit.record({
      action: "catalog.product_created",
      entityType: "product",
      entityId: productId,
      severity: "LOW",
      storeId,
      after: { name: input.name, slug, priceCents: input.priceCents },
    });

    return this.getProduct(storeId, productId);
  }

  async updateProduct(
    storeId: string,
    productId: string,
    patch: {
      name?: string;
      brand?: string | null;
      description?: string | null;
      categoryId?: string | null;
    },
  ) {
    await this.getProduct(storeId, productId);

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.product.update({
        where: { id: productId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.brand !== undefined ? { brand: patch.brand?.trim() || null } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description?.trim() || null }
            : {}),
          ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        },
      }),
    );

    return this.getProduct(storeId, productId);
  }

  /**
   * Publishing is gated on the product actually being sellable. A live product
   * with no price is a customer-facing bug, and the storefront has no sensible
   * way to render it.
   */
  async setProductStatus(storeId: string, productId: string, status: ProductStatus) {
    const product = await this.getProduct(storeId, productId);

    if (status === "ACTIVE") {
      const sellable = product.variants.some((v) => v.active && v.priceCents > 0);
      if (!sellable) {
        throw AppError.validation(
          "Give this product a price before publishing it — customers can't buy something with no price.",
        );
      }
    }

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.product.update({ where: { id: productId }, data: { status } }),
    );

    await this.audit.record({
      action: `catalog.product_${status.toLowerCase()}`,
      entityType: "product",
      entityId: productId,
      severity: "LOW",
      storeId,
      before: { status: product.status },
      after: { status },
    });

    return this.getProduct(storeId, productId);
  }

  /**
   * Soft delete, so order history keeps pointing at something real. Orders
   * snapshot what was bought, but a deleted product that vanished entirely
   * would still break every admin screen that joins back to it.
   */
  async deleteProduct(storeId: string, productId: string): Promise<void> {
    await this.getProduct(storeId, productId);

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      const now = new Date();
      await tx.productVariant.updateMany({
        where: { productId, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.product.update({ where: { id: productId }, data: { deletedAt: now } });
    });

    await this.audit.record({
      action: "catalog.product_deleted",
      entityType: "product",
      entityId: productId,
      severity: "MEDIUM",
      storeId,
    });
  }

  // ── Variants ─────────────────────────────────────────────────────────────

  async addVariant(storeId: string, productId: string, input: VariantInput) {
    await this.getProduct(storeId, productId);
    if (input.sku) await this.assertSkuFree(storeId, input.sku);

    const created = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.productVariant.create({
        data: {
          productId,
          storeId,
          sku: input.sku?.trim() || null,
          barcode: input.barcode?.trim() || null,
          attrs: (input.attrs ?? {}) as never,
          priceCents: input.priceCents,
          compareAtCents: input.compareAtCents ?? null,
          costCents: input.costCents ?? null,
          // Never the default: exactly one exists already, and the database
          // enforces that. Changing it is an explicit action.
          isDefault: false,
        },
      }),
    );

    return created;
  }

  async updateVariant(storeId: string, variantId: string, input: Partial<VariantInput>) {
    const variant = await this.requireVariant(storeId, variantId);
    if (input.sku && input.sku !== variant.sku) await this.assertSkuFree(storeId, input.sku);

    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.productVariant.update({
        where: { id: variantId },
        data: {
          ...(input.sku !== undefined ? { sku: input.sku?.trim() || null } : {}),
          ...(input.barcode !== undefined ? { barcode: input.barcode?.trim() || null } : {}),
          ...(input.attrs !== undefined ? { attrs: input.attrs as never } : {}),
          ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
          ...(input.compareAtCents !== undefined ? { compareAtCents: input.compareAtCents } : {}),
          ...(input.costCents !== undefined ? { costCents: input.costCents } : {}),
        },
      }),
    );
  }

  /** Removing the last variant would leave an unbuyable product, so it is refused. */
  async deleteVariant(storeId: string, variantId: string): Promise<void> {
    const variant = await this.requireVariant(storeId, variantId);

    const remaining = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.productVariant.count({
        where: { productId: variant.productId, deletedAt: null, id: { not: variantId } },
      }),
    );
    if (remaining === 0) {
      throw AppError.validation(
        "A product needs at least one option. Delete the product instead if you're removing it.",
      );
    }

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      await tx.productVariant.update({
        where: { id: variantId },
        data: { deletedAt: new Date(), isDefault: false },
      });

      // Promote a survivor so the product always has a default to price from.
      if (variant.isDefault) {
        const next = await tx.productVariant.findFirst({
          where: { productId: variant.productId, deletedAt: null },
          orderBy: { createdAt: "asc" },
        });
        if (next) {
          await tx.productVariant.update({ where: { id: next.id }, data: { isDefault: true } });
        }
      }
    });
  }

  // ── Images ───────────────────────────────────────────────────────────────

  async attachImage(
    storeId: string,
    productId: string,
    input: { mediaAssetId: string; alt?: string },
  ) {
    await this.getProduct(storeId, productId);

    // Only a processed asset may be attached: a PENDING one has not been
    // validated or re-encoded yet, and a REJECTED one never will be.
    const asset = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.mediaAsset.findFirst({ where: { id: input.mediaAssetId, storeId, status: "READY" } }),
    );
    if (!asset) throw AppError.validation("That image isn't ready yet.");

    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      const last = await tx.productImage.findFirst({
        where: { productId },
        orderBy: { position: "desc" },
      });
      return tx.productImage.create({
        data: {
          productId,
          storeId,
          mediaAssetId: input.mediaAssetId,
          alt: input.alt?.trim() || null,
          position: (last?.position ?? -1) + 1,
        },
      });
    });
  }

  /**
   * Reorders by rewriting every position in one transaction. Positions carry a
   * unique constraint per product, so shuffling them individually would collide
   * partway through.
   */
  async reorderImages(storeId: string, productId: string, imageIds: string[]): Promise<void> {
    await this.getProduct(storeId, productId);

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      const existing = await tx.productImage.findMany({ where: { productId } });
      if (existing.length !== imageIds.length) {
        throw AppError.validation("Send every image id when reordering.");
      }

      // Park them out of the way first, so no intermediate state collides.
      await tx.productImage.updateMany({
        where: { productId },
        data: { position: { increment: 1000 } },
      });
      for (const [index, id] of imageIds.entries()) {
        await tx.productImage.update({ where: { id }, data: { position: index } });
      }
    });
  }

  async detachImage(storeId: string, imageId: string): Promise<void> {
    const { count } = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.productImage.deleteMany({ where: { id: imageId, storeId } }),
    );
    if (count === 0) throw AppError.notFound();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async requireCategory(storeId: string, categoryId: string) {
    const category = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.category.findFirst({ where: { id: categoryId, storeId, deletedAt: null } }),
    );
    if (!category) throw AppError.notFound();
    return category;
  }

  private async requireVariant(storeId: string, variantId: string) {
    const variant = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.productVariant.findFirst({ where: { id: variantId, storeId, deletedAt: null } }),
    );
    if (!variant) throw AppError.notFound();
    return variant;
  }

  private async assertCategorySlugFree(storeId: string, slug: string): Promise<void> {
    const clash = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.category.findFirst({ where: { storeId, slug, deletedAt: null } }),
    );
    if (clash) {
      throw AppError.validation("You already have a category with that name.", [
        { field: "name", code: "DUPLICATE", message: "Pick a different name." },
      ]);
    }
  }

  private async assertSkuFree(storeId: string, sku: string): Promise<void> {
    const clash = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.productVariant.findFirst({ where: { storeId, sku: sku.trim(), deletedAt: null } }),
    );
    if (clash) {
      throw AppError.validation("That SKU is already used by another product.", [
        { field: "sku", code: "DUPLICATE", message: "SKUs must be unique within your store." },
      ]);
    }
  }

  /**
   * Slugs are derived rather than typed, and disambiguated with a suffix.
   * Two products can legitimately share a name ("Sourdough" in two sizes), and
   * failing the create over a URL collision would be an odd thing to explain.
   */
  private async uniqueProductSlug(storeId: string, name: string): Promise<string> {
    const base = slugify(name) || "product";
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const clash = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
        tx.product.findFirst({ where: { storeId, slug: candidate } }),
      );
      if (!clash) return candidate;
    }
    return `${base}-${randomUUID().slice(0, 8)}`;
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
