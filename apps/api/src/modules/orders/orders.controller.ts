import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { ORDER_STATUSES, type MembershipRole, type OrderStatus, type TransitionActor } from "@bba/shared";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { OrdersService } from "./orders.service.js";

const TransitionSchema = z
  .object({
    status: z.enum(ORDER_STATUSES as unknown as [string, ...string[]]),
    note: z.string().max(500).optional(),
  })
  .strict();

/** The store side: the order queue and the workbench. */
@Controller({ path: "stores/:storeId/orders", version: "1" })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermission("orders:read")
  list(
    @Param("storeId") storeId: string,
    @Query("status") status?: string,
    @Query("open") open?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.orders.listForStore(storeId, {
      status: ORDER_STATUSES.includes(status as OrderStatus) ? (status as OrderStatus) : undefined,
      openOnly: open === "true",
      limit: toInt(limit),
      offset: toInt(offset),
    });
  }

  @Get(":orderId")
  @RequirePermission("orders:read")
  get(@Param("storeId") storeId: string, @Param("orderId") orderId: string) {
    return this.orders.getForStore(storeId, orderId);
  }

  /**
   * Moves an order along.
   *
   * Gated by `orders:manage` at the route, and then again by role inside the
   * service: the permission says you may work the queue at all, the state
   * machine says which specific edges your role owns. A driver holding
   * `orders:manage` still cannot cancel an order.
   */
  @Post(":orderId/status")
  @RequirePermission("orders:manage")
  @HttpCode(200)
  transition(
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Body(zodBody(TransitionSchema)) body: z.infer<typeof TransitionSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    const actor = requireActor(req, storeId);
    return this.orders.transition(storeId, orderId, body.status as OrderStatus, actor, body.note);
  }

  @Post(":orderId/payment/cash")
  @RequirePermission("orders:manage")
  @HttpCode(200)
  collectCash(
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.orders.recordCashPayment(storeId, orderId, req.auth.sub);
  }
}

/**
 * The caller's role in this store, which decides which transitions they own.
 *
 * A Super Admin acting on a store has no membership row; they are treated as
 * STORE_ADMIN for transition purposes, which is the widest staff role — not a
 * bypass of the state machine itself.
 */
function requireActor(
  req: AuthenticatedRequest,
  storeId: string,
): { userId: string; role: TransitionActor } {
  if (!req.auth) throw AppError.unauthenticated();

  const membership = req.auth.memberships?.find((m) => m.storeId === storeId);
  if (membership) return { userId: req.auth.sub, role: membership.role as MembershipRole };

  if (req.auth.platformRole === "SUPER_ADMIN") {
    return { userId: req.auth.sub, role: "STORE_ADMIN" };
  }

  throw AppError.forbidden();
}

function toInt(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
