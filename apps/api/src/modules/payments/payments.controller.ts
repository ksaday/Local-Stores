import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { Public } from "../../common/decorators/public.decorator.js";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import type { Env } from "../../config/env.js";
import { PaymentsService } from "./payments.service.js";

const CardPaymentSchema = z
  .object({ idempotencyKey: z.string().min(8).max(200) })
  .strict();

const RefundSchema = z
  .object({
    amountCents: z.number().int().min(1).max(100_000_000).optional(),
    reasonCode: z.string().max(50).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

@Controller({ path: "stores/:storeId/payments", version: "1" })
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Starts Stripe onboarding.
   *
   * `store:payments-config` rather than an orders permission: connecting a
   * bank account is an ownership decision, not something a clerk does between
   * customers. The permission already existed for exactly this.
   */
  @Post("connect/onboard")
  @RequirePermission("store:payments-config")
  @HttpCode(200)
  onboard(@Param("storeId") storeId: string, @Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.payments.startOnboarding(
      storeId,
      req.auth.sub,
      this.config.get("WEB_ORIGIN", { infer: true }),
    );
  }

  @Get("connect")
  @RequirePermission("store:payments-config")
  status(@Param("storeId") storeId: string) {
    return this.payments.getConnectStatus(storeId);
  }

  /** Re-reads from Stripe. The owner presses this after finishing onboarding. */
  @Post("connect/sync")
  @RequirePermission("store:payments-config")
  @HttpCode(200)
  sync(@Param("storeId") storeId: string) {
    return this.payments.syncConnectStatus(storeId);
  }

  @Post("orders/:orderId/refund")
  @RequirePermission("orders:refund")
  @HttpCode(201)
  refund(
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Body(zodBody(RefundSchema)) body: z.infer<typeof RefundSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.payments.refund(storeId, orderId, req.auth.sub, body);
  }

  /**
   * Creates (or returns) the card payment for an order.
   *
   * `@Public()` because a guest can pay for their own order — the claim token
   * in their cookie is what RLS matches, the same way it gates the receipt.
   * The amount comes from the order row, so an unauthenticated caller cannot
   * influence what is charged.
   */
  @Public()
  @Post("orders/:orderId/card")
  @HttpCode(200)
  async createCardPayment(
    @Param("storeId") storeId: string,
    @Param("orderId") orderId: string,
    @Body(zodBody(CardPaymentSchema)) body: z.infer<typeof CardPaymentSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};
    const payment = await this.payments.createCardPayment(storeId, orderId, body.idempotencyKey, {
      userId: req.auth?.sub,
      guestToken: cookies[`bba_order_${orderId}`],
    });

    // The publishable key travels with the response so the browser has one
    // source of Stripe configuration. It is public by design — it can only
    // create payment methods, never move money.
    return {
      ...payment,
      publishableKey: this.config.get("STRIPE_PUBLISHABLE_KEY", { infer: true }) ?? null,
    };
  }

  @Get("orders/:orderId/refunds")
  @RequirePermission("orders:read")
  listRefunds(@Param("storeId") storeId: string, @Param("orderId") orderId: string) {
    return this.payments.listRefunds(storeId, orderId);
  }
}
