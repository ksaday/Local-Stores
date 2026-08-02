import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { PosService } from "./pos.service.js";
import { Req } from "@nestjs/common";

const SaleSchema = z
  .object({
    lines: z
      .array(z.object({ variantId: z.string().uuid(), qty: z.number().int().min(1).max(999) }))
      .min(1)
      .max(100),
    tenderedCents: z.number().int().min(0).max(100_000_000).optional(),
    note: z.string().max(500).nullable().optional(),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();

/**
 * The till.
 *
 * Gated on `orders:create-pos` rather than `orders:manage`: taking money over
 * the counter is a distinct trust decision from working the online queue, and
 * a store may well want staff who can do one but not the other.
 */
@Controller({ path: "stores/:storeId/pos", version: "1" })
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Get("items")
  @RequirePermission("orders:create-pos")
  listItems(@Param("storeId") storeId: string) {
    return this.pos.listTillItems(storeId);
  }

  @Get("lookup")
  @RequirePermission("orders:create-pos")
  lookup(@Param("storeId") storeId: string, @Query("code") code?: string) {
    return this.pos.lookup(storeId, code ?? "");
  }

  @Post("sales")
  @RequirePermission("orders:create-pos")
  @HttpCode(201)
  ringUp(
    @Param("storeId") storeId: string,
    @Body(zodBody(SaleSchema)) body: z.infer<typeof SaleSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.pos.ringUp(storeId, req.auth.sub, body);
  }
}
