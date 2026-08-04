import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { DeliveryService, FAILURE_REASONS } from "./delivery.service.js";

const AssignSchema = z.object({ driverUserId: z.string().uuid() });
const CompleteSchema = z.object({
  proofMediaAssetId: z.string().uuid().optional(),
  signatureMediaAssetId: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
});
const FailSchema = z.object({
  reason: z.enum(FAILURE_REASONS),
  note: z.string().max(500).optional(),
});

/**
 * Deliveries (plan Phase 9).
 *
 * The permission split is the useful one: `delivery:assign` is dispatch —
 * deciding who takes what — while `delivery:update-own` is a driver moving
 * their own parcels. A driver can do the second all day and never the first.
 */
@Controller({ path: "stores/:storeId/deliveries", version: "1" })
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  /** Dispatch board: everything still to go out. */
  @Get()
  @RequirePermission("delivery:read-all")
  board(@Param("storeId") storeId: string) {
    return this.delivery.board(storeId);
  }

  /** The signed-in driver's own round. */
  @Get("mine")
  @RequirePermission("delivery:read-own")
  mine(@Param("storeId") storeId: string, @Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.delivery.queueFor(storeId, req.auth.sub);
  }

  @Post(":orderId/assign")
  @RequirePermission("delivery:assign")
  @HttpCode(200)
  assign(
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(AssignSchema)) body: z.infer<typeof AssignSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.delivery.assign(storeId, orderId, req.auth.sub, body.driverUserId);
  }

  @Post(":orderId/unassign")
  @RequirePermission("delivery:assign")
  @HttpCode(200)
  unassign(
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.delivery.unassign(storeId, orderId, req.auth.sub);
  }

  @Post(":orderId/pick-up")
  @RequirePermission("delivery:update-own")
  @HttpCode(200)
  pickUp(
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.delivery.pickUp(storeId, orderId, req.auth.sub);
  }

  @Post(":orderId/complete")
  @RequirePermission("delivery:update-own")
  @HttpCode(200)
  complete(
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(CompleteSchema)) body: z.infer<typeof CompleteSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.delivery.complete(storeId, orderId, req.auth.sub, body);
  }

  @Post(":orderId/fail")
  @RequirePermission("delivery:update-own")
  @HttpCode(200)
  fail(
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(FailSchema)) body: z.infer<typeof FailSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.delivery.fail(storeId, orderId, req.auth.sub, body);
  }
}
