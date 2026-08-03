import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from "@nestjs/common";
import { z } from "zod";
import type { Permission } from "@bba/shared";
import { Public } from "../../common/decorators/public.decorator.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { LocalDiskStorage, StorageProvider } from "../../infra/storage/storage.provider.js";
import { PermissionResolver } from "../auth/permission-resolver.service.js";
import { MediaService, type MediaKind } from "./media.service.js";

const UploadUrlSchema = z.object({
  kind: z.enum(["PRODUCT", "BRANDING", "PROOF", "SIGNATURE"]),
  mime: z.string().min(1),
  bytes: z.number().int().positive(),
  originalName: z.string().max(255).optional(),
});

/**
 * What each kind of asset is for, and therefore who may create one.
 *
 * The plan gives three alternatives for this route (§10, `catalog:write |
 * store:branding | delivery:update-own`) because the answer depends on what is
 * being uploaded — a clerk who can edit the catalog has no business replacing
 * the shop's logo. `@RequirePermission` is all-of, not one-of, so the check is
 * made here where the kind is known, rather than by loosening the guard for
 * every route that uses it.
 */
const PERMISSION_FOR_KIND: Record<string, Permission> = {
  PRODUCT: "catalog:write",
  BRANDING: "store:branding",
  PROOF: "delivery:update-own",
  SIGNATURE: "delivery:update-own",
};

/**
 * The upload flow (plan §13.7).
 *
 * Three steps, so that untrusted bytes never pass through this process: ask
 * for somewhere to put the file, PUT it straight to storage, then say you have
 * finished. The API sees a declared type and a byte count, and nothing else,
 * until the worker opens the file and decides what it really is.
 */
@Controller({ path: "stores/:storeId/media", version: "1" })
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly permissions: PermissionResolver,
  ) {}

  @Post("upload-url")
  @HttpCode(200)
  async uploadUrl(
    @Param("storeId") storeId: string,
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(UploadUrlSchema)) body: z.infer<typeof UploadUrlSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.assertMayUpload(req, storeId, body.kind);

    return this.media.requestUpload({
      declaredMime: body.mime,
      declaredBytes: body.bytes,
      originalName: body.originalName,
      kind: body.kind as MediaKind,
      storeId,
      ownerUserId: req.auth.sub,
    });
  }

  @Post(":assetId/complete")
  @HttpCode(200)
  async complete(
    @Param("storeId") storeId: string,
    @Param("assetId") assetId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.media.completeUpload(assetId, { storeId, userId: req.auth.sub, isSuperAdmin: false });
  }

  /** Where a client polls while the worker does its work. */
  @Get(":assetId")
  async status(
    @Param("storeId") storeId: string,
    @Param("assetId") assetId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.media.status(assetId, { storeId, userId: req.auth.sub, isSuperAdmin: false });
  }

  private async assertMayUpload(
    req: AuthenticatedRequest,
    storeId: string,
    kind: string,
  ): Promise<void> {
    // Platform staff may traverse any store's operational surface for support,
    // exactly as PermissionsGuard allows — this route only differs in *which*
    // permission it needs, not in who is exempt.
    if (req.auth?.platformRole === "SUPER_ADMIN") return;

    const needed = PERMISSION_FOR_KIND[kind];
    if (!needed) throw AppError.validation("That isn't a kind of file you can upload.");

    const effective = await this.permissions.effectiveFor(req.auth!.sub, storeId);
    if (!effective.has(needed)) {
      throw AppError.forbidden(`This action requires: ${needed}.`);
    }
  }
}

/**
 * The local stand-in for a presigned S3 PUT.
 *
 * Deliberately its own controller, outside the store-scoped path: an S3 PUT
 * carries no session either, and routing it through the same guards would make
 * this a rehearsal of something production never does. Its authority is the
 * signed grant alone, which names the one key it may write, the type it must
 * be, and when it stops working.
 *
 * Registered only when storage is local. With S3 the client PUTs to Amazon and
 * nothing here is involved.
 */
@Controller({ path: "media/upload", version: "1" })
export class MediaUploadController {
  constructor(private readonly storage: StorageProvider) {}

  @Public()
  @Put(":token")
  @HttpCode(200)
  async receive(@Param("token") token: string, @Req() req: AuthenticatedRequest) {
    if (!(this.storage instanceof LocalDiskStorage)) {
      // Production presigns to S3, so a request reaching this route means
      // something is pointing at the wrong place.
      throw AppError.notFound();
    }

    let grant;
    try {
      grant = this.storage.verifyGrant(token);
    } catch {
      // One message for forged, malformed and expired alike: distinguishing
      // them tells someone probing which part to work on.
      throw AppError.forbidden("This upload link is not valid.");
    }

    const body = (req as { body?: unknown }).body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw AppError.validation("Send the file as the request body.");
    }
    if (body.length > grant.maxBytes) {
      throw AppError.validation("That file is larger than the upload allows.");
    }
    // The declared type is fixed by the grant, not read from this request —
    // otherwise the type checked at step one and the type stored would be two
    // different claims by the same caller.
    if (req.headers["content-type"] !== grant.mime) {
      throw AppError.validation("The file's type does not match what was requested.");
    }

    await this.storage.putQuarantine(grant.key, body);
    return { bytes: body.length };
  }
}
