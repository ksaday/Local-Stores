import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { CountSessions } from "./count-sessions.service.js";

const OpenSchema = z.object({ name: z.string().max(120).optional() });
const EnterSchema = z.object({
  variantId: z.string().uuid(),
  countedQty: z.number().int().min(0),
  note: z.string().max(500).optional(),
});

/**
 * Physical counts (plan Phase 6: open → enter → review → post).
 *
 * `inventory:count` throughout, including posting. Whoever walks the shelves is
 * who reconciles them; splitting the permission would mean the person who knows
 * what they saw cannot record it.
 */
@Controller({ path: "stores/:storeId/inventory/counts", version: "1" })
export class CountSessionsController {
  constructor(private readonly counts: CountSessions) {}

  @Get()
  @RequirePermission("inventory:read")
  list(@Param("storeId") storeId: string) {
    return this.counts.list(storeId);
  }

  /** What the screen opens on: the count in progress, or nothing. */
  @Get("current")
  @RequirePermission("inventory:read")
  current(@Param("storeId") storeId: string) {
    return this.counts.current(storeId);
  }

  @Get(":sessionId/lines")
  @RequirePermission("inventory:read")
  lines(@Param("storeId") storeId: string, @Param("sessionId") sessionId: string) {
    return this.counts.lines(storeId, sessionId);
  }

  @Post()
  @RequirePermission("inventory:count")
  open(
    @Param("storeId") storeId: string,
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(OpenSchema)) body: z.infer<typeof OpenSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.counts.open(storeId, req.auth.sub, body.name ?? "Stock count");
  }

  @Post(":sessionId/lines")
  @RequirePermission("inventory:count")
  enter(
    @Param("storeId") storeId: string,
    @Param("sessionId") sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(EnterSchema)) body: z.infer<typeof EnterSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.counts.enter(storeId, sessionId, req.auth.sub, body);
  }

  @Delete(":sessionId/lines/:variantId")
  @RequirePermission("inventory:count")
  @HttpCode(204)
  async removeLine(
    @Param("storeId") storeId: string,
    @Param("sessionId") sessionId: string,
    @Param("variantId") variantId: string,
  ) {
    await this.counts.removeLine(storeId, sessionId, variantId);
  }

  @Post(":sessionId/post")
  @RequirePermission("inventory:count")
  @HttpCode(200)
  postCount(
    @Param("storeId") storeId: string,
    @Param("sessionId") sessionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.counts.post(storeId, sessionId, req.auth.sub);
  }

  @Post(":sessionId/abandon")
  @RequirePermission("inventory:count")
  @HttpCode(204)
  async abandon(
    @Param("storeId") storeId: string,
    @Param("sessionId") sessionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.counts.abandon(storeId, sessionId, req.auth.sub);
  }
}
