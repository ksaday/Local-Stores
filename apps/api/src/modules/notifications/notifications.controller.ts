import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
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

  /**
   * The inbox. Communications happen here rather than in an inbox somewhere
   * else (ADR 0001), so this is the screen that has to be worth opening.
   */
  @Get("inbox")
  async inbox(@Req() req: AuthenticatedRequest, @Query("unread") unread?: string) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.notifications.inbox(req.auth.sub, { unreadOnly: unread === "true" });
  }

  /** The badge in the shell. Called on every page, so it counts and nothing else. */
  @Get("unread-count")
  async unreadCount(@Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return { count: await this.notifications.unreadCount(req.auth.sub) };
  }

  @Post("read")
  @HttpCode(204)
  async readAll(@Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.notifications.markRead(req.auth.sub);
  }

  @Post(":notificationId/read")
  @HttpCode(204)
  async readOne(
    @Req() req: AuthenticatedRequest,
    @Param("notificationId") notificationId: string,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.notifications.markRead(req.auth.sub, notificationId);
  }

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
