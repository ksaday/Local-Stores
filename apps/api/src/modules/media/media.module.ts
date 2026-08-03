import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LocalDiskStorage, StorageProvider } from "../../infra/storage/storage.provider.js";
import type { Env } from "../../config/env.js";
import { MediaController, MediaUploadController } from "./media.controller.js";
import { MediaService } from "./media.service.js";

@Global()
@Module({
  controllers: [MediaController, MediaUploadController],
  providers: [
    {
      provide: StorageProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const origin = `http://localhost:${config.get("PORT", { infer: true })}`;

        // TODO(Phase 12): swap for S3 + CloudFront. The interface exists so that
        // is a provider change, not a rewrite of the upload pipeline.
        return new LocalDiskStorage({
          root: join(process.cwd(), ".storage"),
          publicBaseUrl:
            config.get("MEDIA_BASE_URL", { infer: true }) ??
            // The files are written next to the API, so the API serves them in
            // development. Pointing this at the web origin produces URLs that
            // 404 — nothing over there reads this directory.
            `${origin}/media`,
          // Always this process's own origin, even when MEDIA_BASE_URL points
          // at a CDN: a CDN serves reads, and the local stand-in for a
          // presigned PUT is a route on the API.
          uploadBaseUrl: `${origin}/api/v1/media/upload`,
          // Derived rather than configured. It signs nothing but short-lived
          // local upload grants, and a separate secret would be one more value
          // to set correctly in every environment for no gain. Hashed with a
          // label so what is stored here is not the JWT key itself.
          uploadSecret: createHash("sha256")
            .update(`media-upload:${config.get("JWT_PRIVATE_KEY", { infer: true })}`)
            .digest("hex"),
        });
      },
    },
    MediaService,
  ],
  exports: [MediaService, StorageProvider],
})
export class MediaModule {}
