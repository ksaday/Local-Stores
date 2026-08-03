import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { ADJUSTMENT_REASONS, InventoryService } from "./inventory.service.js";

const ReceiveSchema = z.object({
  variantId: z.string().uuid(),
  qty: z.number().int().positive(),
  note: z.string().max(500).optional(),
});

const AdjustSchema = z.object({
  variantId: z.string().uuid(),
  qtyDelta: z.number().int(),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: z.string().max(500).optional(),
});

const TrackingSchema = z.object({
  tracked: z.boolean(),
  reorderPoint: z.number().int().min(0).nullable().optional(),
  reorderQty: z.number().int().min(0).nullable().optional(),
});

/**
 * Stock, as a ledger rather than a number to edit (plan Phase 6).
 *
 * Receiving and adjusting are separate permissions on purpose: taking a
 * delivery is routine, and writing stock off is the one that needs watching.
 */
@Controller({ path: "stores/:storeId/inventory", version: "1" })
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermission("inventory:read")
  list(
    @Param("storeId") storeId: string,
    @Query("q") q?: string,
    @Query("lowStock") lowStock?: string,
  ) {
    return this.inventory.list(storeId, { q, lowStockOnly: lowStock === "true" });
  }

  @Get("low-stock")
  @RequirePermission("inventory:read")
  lowStock(@Param("storeId") storeId: string) {
    return this.inventory.lowStock(storeId);
  }

  @Get("variants/:variantId/movements")
  @RequirePermission("inventory:read")
  movements(@Param("storeId") storeId: string, @Param("variantId") variantId: string) {
    return this.inventory.movements(storeId, variantId);
  }

  @Post("receive")
  @RequirePermission("inventory:receive")
  receive(
    @Param("storeId") storeId: string,
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(ReceiveSchema)) body: z.infer<typeof ReceiveSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.inventory.receive(storeId, req.auth.sub, body);
  }

  @Post("adjust")
  @RequirePermission("inventory:adjust")
  adjust(
    @Param("storeId") storeId: string,
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(AdjustSchema)) body: z.infer<typeof AdjustSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.inventory.adjust(storeId, req.auth.sub, body);
  }

  @Patch("variants/:variantId/tracking")
  @RequirePermission("inventory:adjust")
  setTracking(
    @Param("storeId") storeId: string,
    @Param("variantId") variantId: string,
    @Req() req: AuthenticatedRequest,
    @Body(zodBody(TrackingSchema)) body: z.infer<typeof TrackingSchema>,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.inventory.setTracking(storeId, req.auth.sub, variantId, body);
  }
}
