import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import sharp, { type Metadata, type Sharp } from "sharp";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { StorageProvider } from "../../infra/storage/storage.provider.js";
import { AuditService } from "../audit/audit.service.js";

export type MediaKind = "PRODUCT" | "BRANDING" | "PROOF" | "SIGNATURE" | "EXPORT";

/**
 * Formats we will accept and re-encode. SVG is deliberately absent: it is XML,
 * it can carry <script>, and browsers execute it when served inline. There is
 * no safe way to accept arbitrary SVG for a storefront (plan §13.7).
 */
const ACCEPTED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

const MAX_BYTES = 10 * 1024 * 1024;

/** Longest edge per variant. `original` is the re-encoded full-size image. */
const VARIANTS = [
  { name: "thumb", edge: 200 },
  { name: "medium", edge: 800 },
  { name: "large", edge: 1600 },
] as const;

interface TenantScope {
  storeId?: string;
  userId?: string;
  isSuperAdmin: boolean;
}

export interface UploadResult {
  assetId: string;
  url: string | null;
  status: "READY" | "REJECTED";
  reason?: string;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditService,
  ) {}

  /**
   * Accept, validate, and process an upload (plan §13.7).
   *
   * Runs inline rather than through a queue because BullMQ is not wired yet
   * (Phase 9). The security properties do not depend on where it runs — bytes
   * reach the public prefix only after validation and re-encoding either way —
   * so moving this to a worker later is a relocation, not a redesign.
   */
  async upload(input: {
    body: Buffer;
    declaredMime: string;
    originalName?: string;
    kind: MediaKind;
    storeId?: string;
    ownerUserId?: string;
  }): Promise<UploadResult> {
    // Cheap checks first, before any bytes are written anywhere.
    if (input.body.length === 0) throw AppError.validation("The file is empty.");
    if (input.body.length > MAX_BYTES) {
      throw AppError.validation(`Files must be under ${MAX_BYTES / 1024 / 1024} MB.`);
    }
    if (!ACCEPTED_MIME.has(input.declaredMime)) {
      throw AppError.validation(
        "Upload a JPEG, PNG, WebP, or AVIF image.",
        [{ field: "file", code: "UNSUPPORTED_TYPE", message: `${input.declaredMime} is not accepted.` }],
      );
    }

    const isPrivate = input.kind === "PROOF" || input.kind === "SIGNATURE";
    // Server-generated key. The user's filename never reaches a path.
    const baseKey = `${input.kind.toLowerCase()}/${randomUUID()}`;
    const quarantineKey = `${baseKey}.bin`;

    const asset = await this.createPendingAsset({
      storeId: input.storeId,
      ownerUserId: input.ownerUserId,
      kind: input.kind,
      storageKey: baseKey,
      mime: input.declaredMime,
      bytes: input.body.length,
      originalName: input.originalName,
      isPrivate,
    });

    await this.storage.putQuarantine(quarantineKey, input.body);

    const scope = { storeId: input.storeId, userId: input.ownerUserId, isSuperAdmin: false };

    try {
      const result = await this.process(asset.id, quarantineKey, baseKey, isPrivate, scope);
      await this.storage.discardQuarantine(quarantineKey);
      return result;
    } catch (err) {
      await this.storage.discardQuarantine(quarantineKey);
      const reason = err instanceof AppError ? err.message : "The file could not be processed.";
      await this.markRejected(asset.id, reason, scope);
      return { assetId: asset.id, url: null, status: "REJECTED", reason };
    }
  }

  private async process(
    assetId: string,
    quarantineKey: string,
    baseKey: string,
    isPrivate: boolean,
    scope: TenantScope,
  ): Promise<UploadResult> {
    const raw = await this.storage.readQuarantine(quarantineKey);

    // Trust the bytes, not the declared type. A caller controls the
    // Content-Type header entirely, so a PHP script announced as image/png
    // would otherwise sail through.
    const { fileTypeFromBuffer } = await import("file-type");
    const detected = await fileTypeFromBuffer(raw);

    if (!detected || !ACCEPTED_MIME.has(detected.mime)) {
      throw AppError.validation(
        `That file isn't a supported image (detected: ${detected?.mime ?? "unknown"}).`,
      );
    }

    // Re-encode rather than pass through. This is what strips EXIF (including
    // GPS coordinates from a phone photo), and what destroys polyglot files
    // whose bytes are valid as both an image and something executable —
    // the output is generated from decoded pixels, not from the input stream.
    let pipeline: Sharp;
    let metadata: Metadata;
    try {
      pipeline = sharp(raw, { failOn: "error" });
      metadata = await pipeline.metadata();
    } catch {
      throw AppError.validation("That image is corrupt or unreadable.");
    }

    if (!metadata.width || !metadata.height) {
      throw AppError.validation("That image has no readable dimensions.");
    }

    // A decompression bomb is small on disk and enormous in memory. Reject on
    // pixel count before sharp allocates a raster for it.
    const megapixels = (metadata.width * metadata.height) / 1_000_000;
    if (megapixels > 50) {
      throw AppError.validation("That image is too large (over 50 megapixels).");
    }

    const written: string[] = [];
    for (const variant of VARIANTS) {
      const buffer = await sharp(raw)
        .rotate() // apply EXIF orientation before the metadata is discarded
        .resize({
          width: variant.edge,
          height: variant.edge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer();

      const key = `${baseKey}/${variant.name}.webp`;
      await this.storage.putProcessed(key, buffer, isPrivate);
      written.push(key);
    }

    const original = await sharp(raw).rotate().webp({ quality: 90 }).toBuffer();
    const originalKey = `${baseKey}/original.webp`;
    await this.storage.putProcessed(originalKey, original, isPrivate);
    written.push(originalKey);

    await this.markReady(assetId, scope, {
      mime: "image/webp",
      bytes: original.length,
      width: metadata.width,
      height: metadata.height,
    });

    this.logger.log(`Media ${assetId} processed into ${written.length} variants`);

    return {
      assetId,
      // Private assets (delivery proofs, signatures) are served via short-lived
      // presigned URLs, never a stable public one.
      url: isPrivate ? null : this.storage.publicUrl(originalKey),
      status: "READY",
    };
  }

  private async createPendingAsset(data: {
    storeId?: string;
    ownerUserId?: string;
    kind: MediaKind;
    storageKey: string;
    mime: string;
    bytes: number;
    originalName?: string;
    isPrivate: boolean;
  }) {
    const id = randomUUID();
    // Raw INSERT: this row is written in a context that may not be able to read
    // it back, and Prisma's create() emits RETURNING, which applies the SELECT
    // policy. Same trap as audit entries and invitation tokens.
    await this.prisma.withTenant(
      { storeId: data.storeId, userId: data.ownerUserId, isSuperAdmin: false },
      (tx) => tx.$executeRaw`
        INSERT INTO media_assets
          (id, store_id, owner_user_id, kind, status, storage_key, mime, bytes,
           original_name, is_private, created_at, updated_at)
        VALUES (
          ${id}, ${data.storeId ?? null}, ${data.ownerUserId ?? null},
          ${data.kind}::"MediaKind", 'PENDING'::"MediaStatus",
          ${data.storageKey}, ${data.mime}, ${data.bytes},
          ${data.originalName ?? null}, ${data.isPrivate}, now(), now()
        )
      `,
    );
    return { id };
  }

  private async markReady(
    assetId: string,
    scope: TenantScope,
    data: { mime: string; bytes: number; width: number; height: number },
  ): Promise<void> {
    // Scoped, not unscoped: RLS on media_assets keys off store_id / owner_user_id,
    // so an unscoped UPDATE matches zero rows and the asset silently stays
    // PENDING — no error, just a file that never becomes usable.
    await this.prisma.withTenant(scope, (tx) => tx.$executeRaw`
      UPDATE media_assets
      SET status = 'READY'::"MediaStatus", mime = ${data.mime}, bytes = ${data.bytes},
          width = ${data.width}, height = ${data.height}, updated_at = now()
      WHERE id = ${assetId}
    `);
  }

  private async markRejected(
    assetId: string,
    reason: string,
    scope: TenantScope,
  ): Promise<void> {
    await this.prisma.withTenant(scope, (tx) => tx.$executeRaw`
      UPDATE media_assets
      SET status = 'REJECTED'::"MediaStatus", reject_reason = ${reason}, updated_at = now()
      WHERE id = ${assetId}
    `);

    await this.audit.record({
      action: "media.rejected",
      entityType: "media_asset",
      entityId: assetId,
      severity: "MEDIUM",
      after: { reason },
    });
  }
}
