import { Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/decorators/public.decorator.js";
import { AppError } from "../../common/errors/app-error.js";
import { StripeWebhooksService } from "./webhooks.service.js";

@Controller({ path: "webhooks", version: "1" })
export class StripeWebhooksController {
  constructor(private readonly webhooks: StripeWebhooksService) {}

  /**
   * Stripe's webhook endpoint.
   *
   * `@Public()` because Stripe has no session — the signature *is* the
   * authentication, and it is stronger than a bearer token because it also
   * covers the body and a timestamp.
   *
   * Reads `req.rawBody`, not the parsed body: the signature is computed over
   * the exact bytes Stripe sent, so any re-serialisation — even one that
   * produces semantically identical JSON — fails verification. `main.ts`
   * keeps the raw buffer for this route specifically.
   */
  @Public()
  @Post("stripe")
  @HttpCode(200)
  async stripe(@Req() req: Request, @Headers("stripe-signature") signature?: string) {
    if (!signature) throw AppError.forbidden("Missing signature.");

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      // A configuration error, not a client error: it means the raw-body
      // middleware is not covering this route and every webhook would fail
      // verification for the wrong reason.
      throw AppError.internal("Webhook raw body is unavailable.");
    }

    const outcome = await this.webhooks.handle(rawBody, signature);

    // Always 200 once handled, including for duplicates. A non-2xx makes
    // Stripe retry, and retrying a replay we correctly ignored achieves
    // nothing but noise.
    return { received: true, ...outcome };
  }
}
