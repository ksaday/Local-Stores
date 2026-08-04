import { Body, Controller, Get, HttpCode, Put, Req } from "@nestjs/common";
import { z } from "zod";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { NOTIFICATION_EVENTS, catalogForDisplay } from "./catalog.js";
import { NotificationsService } from "./notifications.service.js";

const PreferenceSchema = z.object({
  event: z.enum(NOTIFICATION_EVENTS),
  channel: z.enum(["EMAIL", "IN_APP", "PUSH", "SMS"]),
  /** Null or absent means everywhere; a store id narrows it to one shop. */
  storeId: z.string().uuid().nullable().optional(),
  enabled: z.boolean(),
});

/**
 * Somebody's own notification settings.
 *
 * Not store-scoped: these belong to the person, and a shop has no business
 * reading — let alone changing — what a customer wants in their inbox. No
 * `@RequirePermission`, because the only authority needed is being signed in
 * as yourself, and every query is scoped to the caller's own id.
 */
@Controller({ path: "me/notifications", version: "1" })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** What can be switched, with the words the screen should use. */
  @Get("catalog")
  catalog() {
    return catalogForDisplay();
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.notifications.preferencesFor(req.auth.sub);
  }

  @Put()
  @HttpCode(204)
  async set(
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(PreferenceSchema)) body: z.infer<typeof PreferenceSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    try {
      await this.notifications.setPreference(req.auth.sub, body);
    } catch (err) {
      // A switch that does nothing is worse than no switch, so this is a
      // refusal rather than a silent no-op.
      throw AppError.validation(err instanceof Error ? err.message : "Couldn't save that.");
    }
  }
}
