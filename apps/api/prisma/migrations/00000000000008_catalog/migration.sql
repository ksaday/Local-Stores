-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "category_id" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "brand" TEXT,
    "description" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "price_cents" INTEGER NOT NULL,
    "compare_at_cents" INTEGER,
    "cost_cents" INTEGER,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "media_asset_id" TEXT NOT NULL,
    "alt" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_store_id_active_position_idx" ON "categories"("store_id", "active", "position");

-- CreateIndex
CREATE UNIQUE INDEX "categories_store_id_slug_key" ON "categories"("store_id", "slug");

-- CreateIndex
CREATE INDEX "products_store_id_status_category_id_idx" ON "products"("store_id", "status", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_store_id_slug_key" ON "products"("store_id", "slug");

-- CreateIndex
CREATE INDEX "product_variants_product_id_idx" ON "product_variants"("product_id");

-- CreateIndex
CREATE INDEX "product_variants_store_id_barcode_idx" ON "product_variants"("store_id", "barcode");

-- CreateIndex
CREATE INDEX "product_images_store_id_idx" ON "product_images"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_images_product_id_position_key" ON "product_images"("product_id", "position");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Catalog: RLS, search, and the invariants that belong in the database.
-- ---------------------------------------------------------------------------

-- Full-text search over the fields a shopper actually types (plan §7.7).
-- A generated column rather than a trigger-maintained one: it cannot drift
-- from the row it describes, because Postgres recomputes it on every write.
ALTER TABLE products
  ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(brand, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) STORED;

CREATE INDEX products_search_idx ON products USING GIN (search);

-- Fuzzy matching for the store directory and for typo-tolerant product search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm_idx ON products USING GIN (name gin_trgm_ops);
CREATE INDEX stores_name_trgm_idx ON stores USING GIN (name gin_trgm_ops);

-- SKU is unique per store, but only among live variants: a deleted variant
-- must not permanently reserve its SKU, and NULL means "no SKU" rather than
-- one shared blank value.
CREATE UNIQUE INDEX product_variants_store_sku_idx
  ON product_variants (store_id, sku)
  WHERE sku IS NOT NULL AND deleted_at IS NULL;

-- Exactly one default variant per product. Checkout and the storefront both
-- need an unambiguous "the price" for a single-variant product.
CREATE UNIQUE INDEX product_variants_one_default_idx
  ON product_variants (product_id)
  WHERE is_default AND deleted_at IS NULL;

-- Categories are one level deep (plan §8.2). Enforced here rather than in the
-- service so an import or a manual fix cannot build a tree the storefront
-- navigation is not written to render.
CREATE OR REPLACE FUNCTION categories_enforce_depth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'A category cannot be its own parent';
    END IF;
    IF EXISTS (SELECT 1 FROM categories WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Categories can only be one level deep';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER categories_depth_trigger
  BEFORE INSERT OR UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION categories_enforce_depth();

-- Prices are non-negative integers in cents. A negative price is not a
-- discount, it is a bug that pays the customer.
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_price_non_negative CHECK (price_cents >= 0),
  ADD CONSTRAINT product_variants_compare_at_non_negative
    CHECK (compare_at_cents IS NULL OR compare_at_cents >= 0),
  ADD CONSTRAINT product_variants_cost_non_negative
    CHECK (cost_cents IS NULL OR cost_cents >= 0);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Staff read and write within their store. Reads are additionally public for
-- ACTIVE stores, because a storefront has to be browsable by someone with no
-- account — that is the entire point of a shop window.

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY categories_read ON categories FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR (deleted_at IS NULL AND active
      AND store_id IN (SELECT id FROM stores WHERE status = 'ACTIVE'))
);
CREATE POLICY categories_write ON categories FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
-- Only ACTIVE products in ACTIVE stores are public. A DRAFT product is the
-- owner's work in progress and must not be reachable by guessing a URL.
CREATE POLICY products_read ON products FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR (deleted_at IS NULL AND status = 'ACTIVE'
      AND store_id IN (SELECT id FROM stores WHERE status = 'ACTIVE'))
);
CREATE POLICY products_write ON products FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants FORCE ROW LEVEL SECURITY;
CREATE POLICY product_variants_read ON product_variants FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR (deleted_at IS NULL AND active AND product_id IN (
        SELECT p.id FROM products p JOIN stores s ON s.id = p.store_id
        WHERE p.status = 'ACTIVE' AND p.deleted_at IS NULL AND s.status = 'ACTIVE'))
);
CREATE POLICY product_variants_write ON product_variants FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images FORCE ROW LEVEL SECURITY;
CREATE POLICY product_images_read ON product_images FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR product_id IN (
        SELECT p.id FROM products p JOIN stores s ON s.id = p.store_id
        WHERE p.status = 'ACTIVE' AND p.deleted_at IS NULL AND s.status = 'ACTIVE')
);
CREATE POLICY product_images_write ON product_images FOR ALL
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON products TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_variants TO bba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_images TO bba_app;
