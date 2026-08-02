import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { join } from "node:path";
import { LocalDiskStorage, StorageProvider } from "../../infra/storage/storage.provider.js";
import type { Env } from "../../config/env.js";
import { MediaService } from "./media.service.js";

@Global()
@Module({
  providers: [
    {
      provide: StorageProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        // TODO(Phase 12): swap for S3 + CloudFront. The interface exists so that
        // is a provider change, not a rewrite of the upload pipeline.
        new LocalDiskStorage(
          join(process.cwd(), ".storage"),
          config.get("MEDIA_BASE_URL", { infer: true }) ??
            // The files are written next to the API, so the API serves them in
            // development. Pointing this at the web origin produces URLs that
            // 404 — nothing over there reads this directory.
            `http://localhost:${config.get("PORT", { infer: true })}/media`,
        ),
    },
    MediaService,
  ],
  exports: [MediaService, StorageProvider],
})
export class MediaModule {}
