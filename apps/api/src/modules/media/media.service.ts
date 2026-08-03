import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import sharp, { type Metadata, type Sharp } from "sharp";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { MediaQueue } from "../../infra/queue/queue.module.js";
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
  status: "PENDING" | "READY" | "REJECTED";
  reason?: string;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditService,
    private readonly queue: MediaQueue,
  ) {}

  /**
   * Accept an upload and hand it to the media queue (plan §13.7).
   *
   * Returns as soon as the bytes are in quarantine. Decoding and re-encoding
   * four variants of a ten-megapixel photo is seconds of CPU, and it used to
   * happen inside the caller's request — one upload could hold a request open
   * long enough to look like a hang, and several at once would saturate the
   * event loop for every other request the process was serving.
   *
   * The security properties are unchanged by the move: bytes reach the public
   * prefix only after magic-byte validation and re-encoding, and they sit in
   * the quarantine prefix (never publicly served) until then. What changes is
   * only where that happens.
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
    await this.queue.enqueue({ assetId: asset.id, quarantineKey });

    return { assetId: asset.id, url: null, status: "PENDING" };
  }

  /**
   * Validate and re-encode a quarantined upload. Runs on the worker.
   *
   * Takes only the ids: everything else is re-read from the asset row, because
   * a job may be picked up by a different process minutes after the upload, and
   * anything passed through the payload would be a second copy of state that
   * could disagree with the database.
   */
  async processQueued(assetId: string, quarantineKey: string): Promise<UploadResult> {
    // Read as the platform. The job has no request behind it and therefore no
    // tenant context of its own; the row's own store and owner are what the
    // subsequent writes are scoped to.
    const [asset] = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<
        { store_id: string | null; owner_user_id: string | null; storage_key: string; is_private: boolean }[]
      >`
        SELECT store_id, owner_user_id, storage_key, is_private
        FROM media_assets WHERE id = ${assetId}
      `,
    );

    if (!asset) {
      // Deleted between upload and processing. Nothing to do, and nothing
      // wrong — but the quarantined bytes should not be left behind.
      await this.storage.discardQuarantine(quarantineKey);
      this.logger.warn(`Media ${assetId} no longer exists; discarded its upload`);
      return { assetId, url: null, status: "REJECTED", reason: "The asset no longer exists." };
    }

    const scope: TenantScope = {
      storeId: asset.store_id ?? undefined,
      userId: asset.owner_user_id ?? undefined,
      isSuperAdmin: false,
    };

    try {
      const result = await this.process(
        assetId,
        quarantineKey,
        asset.storage_key,
        asset.is_private,
        scope,
      );
      await this.storage.discardQuarantine(quarantineKey);
      return result;
    } catch (err) {
      // A rejection is a verdict on the file, not a failure of the job: the
      // answer will be the same next time, so it is recorded and the job
      // completes rather than retrying three times to reach it again.
      await this.storage.discardQuarantine(quarantineKey);
      const reason = err instanceof AppError ? err.message : "The file could not be processed.";
      await this.markRejected(assetId, reason, scope);
      return { assetId, url: null, status: "REJECTED", reason };
    }
  }

  /** The current state of an upload, for a caller waiting on it. */
  async status(assetId: string, scope: TenantScope): Promise<UploadResult> {
    const [asset] = await this.prisma.withTenant(scope, (tx) =>
      tx.$queryRaw<
        { status: string; storage_key: string; is_private: boolean; reject_reason: string | null }[]
      >`
        SELECT status::text, storage_key, is_private, reject_reason
        FROM media_assets WHERE id = ${assetId}
      `,
    );
    if (!asset) throw AppError.notFound();

    return {
      assetId,
      status: asset.status as UploadResult["status"],
      url:
        asset.status === "READY" && !asset.is_private
          ? this.storage.publicUrl(`${asset.storage_key}/original.webp`)
          : null,
      ...(asset.reject_reason ? { reason: asset.reject_reason } : {}),
    };
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
