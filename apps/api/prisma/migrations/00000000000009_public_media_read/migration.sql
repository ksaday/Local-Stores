-- Public read access to media that is already public by intent.
--
-- Before this, `product_images` and `stores.branding` were publicly readable
-- but `media_assets` was not, so an anonymous storefront request could see that
-- a product HAS an image and never resolve where it lives. Product listings
-- without pictures are not a storefront.
--
-- The existing policy was FOR ALL, where USING also decides which rows a
-- DELETE or UPDATE may touch. Adding the public branch there would have let an
-- anonymous request delete any public asset. So it is split: a SELECT policy
-- that carries the public branch, and a write policy that does not — the same
-- shape the catalog tables use.

DROP POLICY media_assets_tenant ON media_assets;

CREATE POLICY media_assets_read ON media_assets FOR SELECT USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = NULLIF(current_setting('app.store_id', true), '')
  OR owner_user_id = NULLIF(current_setting('app.user_id', true), '')
  -- Only finished, non-private assets belonging to a live store. `is_private`
  -- is what keeps delivery proofs and signatures out; PENDING means the file
  -- has not cleared the magic-byte check and re-encode yet, and REJECTED means
  -- it failed. Neither may ever be served from our origin.
  OR (
    is_private = false
    AND status = 'READY'
    AND store_id IN (SELECT id FROM stores WHERE status = 'ACTIVE' AND deleted_at IS NULL)
  )
);

CREATE POLICY media_assets_write ON media_assets FOR ALL
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
