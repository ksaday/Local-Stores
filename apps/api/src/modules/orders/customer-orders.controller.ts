import { Controller, Get, Param, Req } from "@nestjs/common";
import { Public } from "../../common/decorators/public.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { OrdersService } from "./orders.service.js";

/**
 * The customer side of orders.
 *
 * Separate from the store controller because the authorization model is
 * different in kind: the store reaches orders through a membership and a
 * permission, a customer reaches only their own, and a guest reaches exactly
 * one via a claim token. Sharing routes between those would mean one handler
 * juggling three notions of "allowed".
 */
@Controller({ path: "orders", version: "1" })
export class CustomerOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.orders.listForCustomer(req.auth.sub);
  }

  /**
   * One order, for whoever legitimately holds it.
   *
   * Public so a guest can open their receipt without an account; the claim
   * token in their cookie is what RLS matches on. No token and no session
   * means no row, which surfaces as a 404.
   */
  @Public()
  @Get(":orderId")
  get(@Param("orderId") orderId: string, @Req() req: AuthenticatedRequest) {
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};
    return this.orders.getForCustomer(orderId, {
      userId: req.auth?.sub,
      guestToken: cookies[`bba_order_${orderId}`],
    });
  }
}
