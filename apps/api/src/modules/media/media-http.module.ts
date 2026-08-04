import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import {
  MediaController,
  MediaPrivateController,
  MediaUploadController,
} from "./media.controller.js";

/**
 * The media routes, kept apart from `MediaModule`.
 *
 * `MediaModule` is imported by the worker for its service; controllers are not,
 * and must not be — the worker has no HTTP surface, and a controller pulls in
 * `PermissionResolver` and the request-side graph behind it. Splitting them is
 * what keeps "the worker imports the API's domain modules" true without also
 * importing the API's routes.
 */
@Module({
  imports: [AuthModule],
  controllers: [MediaController, MediaUploadController, MediaPrivateController],
})
export class MediaHttpModule {}
