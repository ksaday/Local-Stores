import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../config/env.js";
import { PaymentProvider } from "../../infra/payments/payment.provider.js";
import { StripePaymentProvider } from "../../infra/payments/stripe.provider.js";
import { UnconfiguredPaymentProvider } from "../../infra/payments/unconfigured.provider.js";
import { OrdersModule } from "../orders/orders.module.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { StripeWebhooksController } from "./webhooks.controller.js";
import { StripeWebhooksService } from "./webhooks.service.js";

@Module({
  imports: [OrdersModule],
  controllers: [PaymentsController, StripeWebhooksController],
  providers: [
    PaymentsService,
    StripeWebhooksService,
    {
      provide: PaymentProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const secretKey = config.get("STRIPE_SECRET_KEY", { infer: true });
        const webhookSecret = config.get("STRIPE_WEBHOOK_SECRET", { infer: true });

        // Running without Stripe configured is a supported state, not a
        // broken one: the platform is cash-capable on its own. A provider that
        // refuses clearly beats a null that explodes at the point of payment.
        if (!secretKey || !webhookSecret) return new UnconfiguredPaymentProvider();

        return new StripePaymentProvider(secretKey, webhookSecret);
      },
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
