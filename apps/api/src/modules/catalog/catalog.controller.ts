import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { CatalogService } from "./catalog.service.js";

const CategorySchema = z
  .object({
    name: z.string().min(1).max(80),
    parentId: z.string().uuid().nullable().optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .strict();

const CategoryPatchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    position: z.number().int().min(0).max(999).optional(),
    active: z.boolean().optional(),
  })
  .strict();

const ProductSchema = z
  .object({
    name: z.string().min(1).max(160),
    brand: z.string().max(80).optional(),
    description: z.string().max(4000).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    // Money crosses the wire as integer cents so no rounding happens in transit.
    priceCents: z.number().int().min(0).max(100_000_000),
    sku: z.string().max(64).nullable().optional(),
  })
  .strict();

const ProductPatchSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    brand: z.string().max(80).nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
  })
  .strict();

const StatusSchema = z.object({ status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]) }).strict();

const VariantSchema = z
  .object({
    sku: z.string().max(64).nullable().optional(),
    barcode: z.string().max(64).nullable().optional(),
    attrs: z.record(z.string()).optional(),
    priceCents: z.number().int().min(0).max(100_000_000),
    compareAtCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
    costCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  })
  .strict();

const VariantPatchSchema = VariantSchema.partial().strict();

const ImageSchema = z
  .object({ mediaAssetId: z.string().uuid(), alt: z.string().max(200).optional() })
  .strict();

const ReorderSchema = z.object({ imageIds: z.array(z.string().uuid()).max(20) }).strict();

@Controller({ path: "stores/:storeId", version: "1" })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ── Categories ───────────────────────────────────────────────────────────

  @Get("categories")
  @RequirePermission("catalog:read")
  listCategories(@Param("storeId") storeId: string) {
    return this.catalog.listCategories(storeId);
  }

  @Post("categories")
  @RequirePermission("catalog:write")
  @HttpCode(201)
  createCategory(
    @Param("storeId") storeId: string,
    @Body(zodBody(CategorySchema)) body: z.infer<typeof CategorySchema>,
  ) {
    return this.catalog.createCategory(storeId, body);
  }

  @Patch("categories/:categoryId")
  @RequirePermission("catalog:write")
  updateCategory(
    @Param("storeId") storeId: string,
    @Param("categoryId") categoryId: string,
    @Body(zodBody(CategoryPatchSchema)) body: z.infer<typeof CategoryPatchSchema>,
  ) {
    return this.catalog.updateCategory(storeId, categoryId, body);
  }

  @Delete("categories/:categoryId")
  @RequirePermission("catalog:write")
  @HttpCode(204)
  async deleteCategory(
    @Param("storeId") storeId: string,
    @Param("categoryId") categoryId: string,
  ) {
    await this.catalog.deleteCategory(storeId, categoryId);
  }

  // ── Products ─────────────────────────────────────────────────────────────

  @Get("products")
  @RequirePermission("catalog:read")
  listProducts(
    @Param("storeId") storeId: string,
    @Query("status") status?: "DRAFT" | "ACTIVE" | "ARCHIVED",
    @Query("categoryId") categoryId?: string,
    @Query("q") q?: string,
  ) {
    return this.catalog.listProducts(storeId, { status, categoryId, q });
  }

  @Get("products/:productId")
  @RequirePermission("catalog:read")
  getProduct(@Param("storeId") storeId: string, @Param("productId") productId: string) {
    return this.catalog.getProduct(storeId, productId);
  }

  @Post("products")
  @RequirePermission("catalog:write")
  @HttpCode(201)
  createProduct(
    @Param("storeId") storeId: string,
    @Body(zodBody(ProductSchema)) body: z.infer<typeof ProductSchema>,
  ) {
    return this.catalog.createProduct(storeId, body);
  }

  @Patch("products/:productId")
  @RequirePermission("catalog:write")
  updateProduct(
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Body(zodBody(ProductPatchSchema)) body: z.infer<typeof ProductPatchSchema>,
  ) {
    return this.catalog.updateProduct(storeId, productId, body);
  }

  /**
   * Publishing is a separate permission from editing (plan §4.3): an inventory
   * manager may maintain the catalog without deciding what goes live.
   */
  @Patch("products/:productId/status")
  @RequirePermission("catalog:publish")
  setStatus(
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Body(zodBody(StatusSchema)) body: z.infer<typeof StatusSchema>,
  ) {
    return this.catalog.setProductStatus(storeId, productId, body.status);
  }

  @Delete("products/:productId")
  @RequirePermission("catalog:write")
  @HttpCode(204)
  async deleteProduct(@Param("storeId") storeId: string, @Param("productId") productId: string) {
    await this.catalog.deleteProduct(storeId, productId);
  }

  // ── Variants ─────────────────────────────────────────────────────────────

  @Post("products/:productId/variants")
  @RequirePermission("catalog:write")
  @HttpCode(201)
  addVariant(
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Body(zodBody(VariantSchema)) body: z.infer<typeof VariantSchema>,
  ) {
    return this.catalog.addVariant(storeId, productId, body);
  }

  @Patch("variants/:variantId")
  @RequirePermission("catalog:write")
  updateVariant(
    @Param("storeId") storeId: string,
    @Param("variantId") variantId: string,
    @Body(zodBody(VariantPatchSchema)) body: z.infer<typeof VariantPatchSchema>,
  ) {
    return this.catalog.updateVariant(storeId, variantId, body);
  }

  @Delete("variants/:variantId")
  @RequirePermission("catalog:write")
  @HttpCode(204)
  async deleteVariant(@Param("storeId") storeId: string, @Param("variantId") variantId: string) {
    await this.catalog.deleteVariant(storeId, variantId);
  }

  // ── Images ───────────────────────────────────────────────────────────────

  @Post("products/:productId/images")
  @RequirePermission("catalog:write")
  @HttpCode(201)
  attachImage(
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Body(zodBody(ImageSchema)) body: z.infer<typeof ImageSchema>,
  ) {
    return this.catalog.attachImage(storeId, productId, body);
  }

  @Patch("products/:productId/images/reorder")
  @RequirePermission("catalog:write")
  @HttpCode(204)
  async reorderImages(
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Body(zodBody(ReorderSchema)) body: z.infer<typeof ReorderSchema>,
  ) {
    await this.catalog.reorderImages(storeId, productId, body.imageIds);
  }

  @Delete("images/:imageId")
  @RequirePermission("catalog:write")
  @HttpCode(204)
  async detachImage(@Param("storeId") storeId: string, @Param("imageId") imageId: string) {
    await this.catalog.detachImage(storeId, imageId);
  }
}
