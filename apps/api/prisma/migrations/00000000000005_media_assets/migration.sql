-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('PRODUCT', 'BRANDING', 'PROOF', 'SIGNATURE', 'EXPORT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'REJECTED');

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "store_id" TEXT,
    "owner_user_id" TEXT,
    "kind" "MediaKind" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "original_name" TEXT,
    "reject_reason" TEXT,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storage_key_key" ON "media_assets"("storage_key");

-- CreateIndex
CREATE INDEX "media_assets_store_id_kind_status_idx" ON "media_assets"("store_id", "kind", "status");


-- Tenant-scoped, with an own-user branch for assets that belong to a person
-- rather than a store (delivery proof photos, signatures).
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;

CREATE POLICY media_assets_tenant ON media_assets
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
    OR owner_user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'true'
    OR store_id = NULLIF(current_setting('app.store_id', true), '')
    OR owner_user_id = NULLIF(current_setting('app.user_id', true), '')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON media_assets TO bba_app;
