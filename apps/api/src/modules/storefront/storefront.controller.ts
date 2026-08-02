import { Controller, Get, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../common/decorators/public.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import { StorefrontService } from "./storefront.service.js";

const SORTS = ["relevance", "price_asc", "price_desc", "newest"] as const;
const TYPES = ["RETAIL", "RESTAURANT", "SERVICE"] as const;

/**
 * Unauthenticated storefront reads.
 *
 * Every route is @Public() — a shop window that requires an account is not a
 * shop window. Visibility is enforced by RLS rather than by these handlers:
 * draft products and non-live stores are invisible to an anonymous query at
 * the database level.
 */
@Controller({ path: "public", version: "1" })
export class StorefrontController {
  constructor(private readonly storefront: StorefrontService) {}

  @Public()
  @Get("stores")
  listStores(
    @Query("q") q?: string,
    @Query("businessType") businessType?: string,
    @Query("limit") limit?: string,
  ) {
    const type = TYPES.includes(businessType as never)
      ? (businessType as (typeof TYPES)[number])
      : undefined;
    return this.storefront.listStores({ q, businessType: type, limit: toInt(limit) });
  }

  @Public()
  @Get("stores/:slug")
  getStore(@Param("slug") slug: string) {
    return this.storefront.getStore(slug);
  }

  @Public()
  @Get("stores/:slug/categories")
  listCategories(@Param("slug") slug: string) {
    return this.storefront.listCategories(slug);
  }

  @Public()
  @Get("stores/:slug/products")
  listProducts(
    @Param("slug") slug: string,
    @Query("q") q?: string,
    @Query("category") categorySlug?: string,
    @Query("minCents") minCents?: string,
    @Query("maxCents") maxCents?: string,
    @Query("sort") sort?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const parsedSort = SORTS.includes(sort as never) ? (sort as (typeof SORTS)[number]) : undefined;
    const min = toInt(minCents);
    const max = toInt(maxCents);
    if (min !== undefined && max !== undefined && min > max) {
      throw AppError.validation("The minimum price can't be above the maximum.");
    }

    return this.storefront.listProducts(slug, {
      q,
      categorySlug,
      minCents: min,
      maxCents: max,
      sort: parsedSort,
      limit: toInt(limit),
      offset: toInt(offset),
    });
  }

  @Public()
  @Get("stores/:slug/products/:productSlug")
  getProduct(@Param("slug") slug: string, @Param("productSlug") productSlug: string) {
    return this.storefront.getProduct(slug, productSlug);
  }

  /** Feeds the web app's sitemap generation (NFR-SEO-03). */
  @Public()
  @Get("sitemap-entries")
  sitemap() {
    return this.storefront.sitemapEntries();
  }
}

function toInt(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const StorefrontQuerySchema = z.object({}).passthrough();
