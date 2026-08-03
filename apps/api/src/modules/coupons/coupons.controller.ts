import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { CouponsService } from "./coupons.service.js";

const CouponSchema = z
  .object({
    code: z.string().min(2).max(40),
    kind: z.enum(["PERCENT", "FIXED"]),
    // Basis points for PERCENT (10000 = 100%), cents for FIXED.
    value: z.number().int().min(1).max(10_000_000),
    minOrderCents: z.number().int().min(0).max(100_000_000).optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
    perCustomerLimit: z.number().int().min(1).max(1000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const CouponPatchSchema = CouponSchema.partial().strict();

@Controller({ path: "stores/:storeId/coupons", version: "1" })
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @RequirePermission("coupons:manage")
  list(@Param("storeId") storeId: string) {
    return this.coupons.list(storeId);
  }

  @Post()
  @RequirePermission("coupons:manage")
  @HttpCode(201)
  create(
    @Param("storeId") storeId: string,
    @Body(zodBody(CouponSchema)) body: z.infer<typeof CouponSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.coupons.create(storeId, req.auth.sub, body);
  }

  @Patch(":couponId")
  @RequirePermission("coupons:manage")
  @HttpCode(204)
  async update(
    @Param("storeId") storeId: string,
    @Param("couponId") couponId: string,
    @Body(zodBody(CouponPatchSchema)) body: z.infer<typeof CouponPatchSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.coupons.update(storeId, couponId, req.auth.sub, body);
  }

  @Delete(":couponId")
  @RequirePermission("coupons:manage")
  @HttpCode(204)
  async remove(
    @Param("storeId") storeId: string,
    @Param("couponId") couponId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.coupons.remove(storeId, couponId, req.auth.sub);
  }
}
