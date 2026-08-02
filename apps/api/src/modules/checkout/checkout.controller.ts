import { Body, Controller, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Public } from "../../common/decorators/public.decorator.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { CART_COOKIE } from "../cart/cart.controller.js";
import type { Shopper } from "../cart/cart.service.js";
import { CheckoutService } from "./checkout.service.js";

const AddressSchema = z
  .object({
    line1: z.string().min(1).max(200),
    line2: z.string().max(200).nullable().optional(),
    city: z.string().min(1).max(100),
    state: z.string().length(2),
    postalCode: z.string().min(3).max(12),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
  })
  .strict();

const QuoteSchema = z
  .object({
    fulfillment: z.enum(["PICKUP", "DELIVERY"]),
    address: AddressSchema.nullable().optional(),
    tipCents: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

const PlaceOrderSchema = QuoteSchema.extend({
  contactEmail: z.string().email().max(200).nullable().optional(),
  contactPhone: z.string().max(40).nullable().optional(),
  customerNote: z.string().max(1000).nullable().optional(),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

@Controller({ path: "stores/:storeId/checkout", version: "1" })
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /** Prices the cart. Safe to call as the shopper edits the form. */
  @Public()
  @Post("quote")
  @HttpCode(200)
  async quote(
    @Param("storeId") storeId: string,
    @Body(zodBody(QuoteSchema)) body: z.infer<typeof QuoteSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.checkout.quote(storeId, requireShopper(req), body);
  }

  /**
   * Places the order.
   *
   * A guest gets their claim token back in an httpOnly cookie rather than only
   * in the response body: it is what lets them reload the confirmation page or
   * come back later, and it should not be sitting in a URL or in localStorage.
   */
  @Public()
  @Post()
  @HttpCode(201)
  async place(
    @Param("storeId") storeId: string,
    @Body(zodBody(PlaceOrderSchema)) body: z.infer<typeof PlaceOrderSchema>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const order = await this.checkout.placeOrder(storeId, requireShopper(req), body);

    if (order.guestToken) {
      res.cookie(`bba_order_${order.id}`, order.guestToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE !== "false",
        maxAge: 90 * 86_400_000,
        path: "/",
      });
    }

    return order;
  }
}

/**
 * The shopper placing the order.
 *
 * Unlike the cart endpoints, checkout does not mint a new guest key: arriving
 * here without a cart cookie means there is no cart to check out, and issuing
 * an identity would only turn that into a confusing empty-cart error later.
 */
function requireShopper(req: AuthenticatedRequest): Shopper {
  if (req.auth?.sub) return { kind: "user", userId: req.auth.sub };

  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};
  const sessionKey = cookies[CART_COOKIE];
  if (sessionKey) return { kind: "guest", sessionKey };

  // Deliberately not a 401: the shopper is not unauthenticated, they have an
  // empty cart. Saying "sign in" here would be wrong and unhelpful.
  return { kind: "guest", sessionKey: randomBytes(8).toString("base64url") };
}
