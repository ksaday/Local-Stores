import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import type { Env } from "../../config/env.js";
import { BillingService } from "./billing.service.js";

/**
 * The store's own billing.
 *
 * Gated on `store:payments-config` — the same permission as connecting Stripe.
 * Both are decisions about the shop's money that belong to whoever owns it,
 * not to whoever is working the counter.
 */
@Controller({ path: "stores/:storeId/billing", version: "1" })
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  @RequirePermission("store:payments-config")
  status(@Param("storeId") storeId: string) {
    return this.billing.getSubscription(storeId);
  }

  @Post("subscribe")
  @RequirePermission("store:payments-config")
  @HttpCode(200)
  subscribe(@Param("storeId") storeId: string, @Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.billing.startSubscription(storeId, req.auth.sub);
  }

  @Post("portal")
  @RequirePermission("store:payments-config")
  @HttpCode(200)
  async portal(@Param("storeId") storeId: string) {
    const origin = this.config.get("WEB_ORIGIN", { infer: true });
    const url = await this.billing.billingPortalUrl(storeId, `${origin}/store/${storeId}/ops/settings`);
    return { url };
  }
}
