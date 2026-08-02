import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Public } from "../../common/decorators/public.decorator.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { CartService, type Shopper } from "./cart.service.js";

const AddItemSchema = z
  .object({ variantId: z.string().uuid(), qty: z.number().int().min(1).max(99).default(1) })
  .strict();

const UpdateItemSchema = z.object({ qty: z.number().int().min(0).max(99) }).strict();

/** Cookie holding the guest cart key. */
export const CART_COOKIE = "bba_cart";
const CART_COOKIE_MAX_AGE_MS = 30 * 86_400_000;

/**
 * Cart endpoints.
 *
 * `@Public()` because shopping must work before signing in — requiring an
 * account to put something in a basket is how a corner shop loses the sale.
 * The guard still populates `req.auth` when a session is present, so a
 * signed-in shopper is recognised without a second code path.
 */
@Controller({ path: "stores/:storeId/cart", version: "1" })
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Public()
  @Get()
  async get(@Param("storeId") storeId: string, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const shopper = this.resolveShopper(req, res);
    return this.cart.getCart(storeId, shopper);
  }

  @Public()
  @Post("items")
  async add(
    @Param("storeId") storeId: string,
    @Body(zodBody(AddItemSchema)) body: z.infer<typeof AddItemSchema>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const shopper = this.resolveShopper(req, res);
    return this.cart.addItem(storeId, shopper, body.variantId, body.qty);
  }

  @Public()
  @Patch("items/:itemId")
  async update(
    @Param("storeId") storeId: string,
    @Param("itemId") itemId: string,
    @Body(zodBody(UpdateItemSchema)) body: z.infer<typeof UpdateItemSchema>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const shopper = this.resolveShopper(req, res);
    return this.cart.updateItem(storeId, shopper, itemId, body.qty);
  }

  @Public()
  @Delete("items/:itemId")
  async remove(
    @Param("storeId") storeId: string,
    @Param("itemId") itemId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const shopper = this.resolveShopper(req, res);
    return this.cart.removeItem(storeId, shopper, itemId);
  }

  @Public()
  @Delete()
  async clear(@Param("storeId") storeId: string, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const shopper = this.resolveShopper(req, res);
    return this.cart.clear(storeId, shopper);
  }

  /**
   * Who is shopping — the signed-in user, or a guest key from a cookie.
   *
   * A signed-in user is always preferred, so their cart follows them between
   * devices rather than being pinned to whichever browser holds the cookie.
   * A guest with no cookie gets one minted here; it is httpOnly because
   * nothing in the browser needs to read it, and it is a capability that
   * grants access to a cart.
   */
  private resolveShopper(req: AuthenticatedRequest, res: Response): Shopper {
    if (req.auth?.sub) return { kind: "user", userId: req.auth.sub };

    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};
    const existing = cookies[CART_COOKIE];
    if (existing) return { kind: "guest", sessionKey: existing };

    const sessionKey = randomBytes(24).toString("base64url");
    res.cookie(CART_COOKIE, sessionKey, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE !== "false",
      maxAge: CART_COOKIE_MAX_AGE_MS,
      path: "/",
    });
    return { kind: "guest", sessionKey };
  }
}
