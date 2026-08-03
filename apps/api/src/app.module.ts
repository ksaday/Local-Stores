import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { validateEnv } from "./config/env.js";
import { PrismaModule } from "./infra/prisma/prisma.module.js";
import { MailerModule } from "./infra/mailer/mailer.module.js";
import { OutboxModule } from "./infra/outbox/outbox.module.js";
import { InventoryModule } from "./modules/inventory/inventory.module.js";
import { MediaHttpModule } from "./modules/media/media-http.module.js";
import { MediaModule } from "./modules/media/media.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { BillingModule } from "./modules/billing/billing.module.js";
import { CartModule } from "./modules/cart/cart.module.js";
import { CouponsModule } from "./modules/coupons/coupons.module.js";
import { CatalogModule } from "./modules/catalog/catalog.module.js";
import { CheckoutModule } from "./modules/checkout/checkout.module.js";
import { OrderEventsModule } from "./modules/orders/order-events.module.js";
import { OrdersModule } from "./modules/orders/orders.module.js";
import { PaymentsModule } from "./modules/payments/payments.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { StorefrontModule } from "./modules/storefront/storefront.module.js";
import { StoresModule } from "./modules/stores/stores.module.js";
import { RequestContextMiddleware } from "./common/middleware/request-context.middleware.js";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard.js";
import { StoreScopeGuard } from "./common/guards/store-scope.guard.js";
import { PermissionsGuard } from "./common/guards/permissions.guard.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Throws at boot on invalid config rather than failing at first request.
      validate: validateEnv,
    }),
    PrismaModule,
    MailerModule,
    OutboxModule,
    MediaModule,
    MediaHttpModule,
    InventoryModule,
    AuditModule,
    AuthModule,
    StoresModule,
    CatalogModule,
    StorefrontModule,
    OrderEventsModule,
    CartModule,
    CouponsModule,
    CheckoutModule,
    OrdersModule,
    PaymentsModule,
    BillingModule,
    HealthModule,
  ],
  providers: [
    // Registered globally and in this order (plan §12.3): identity, then store
    // scope, then permissions. Global rather than per-controller so a new route
    // is protected by default — @Public() is the explicit, reviewable opt-out.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: StoreScopeGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Express 5 / path-to-regexp v8 requires named wildcards; bare "*" is legacy.
    consumer.apply(RequestContextMiddleware).forRoutes("{*path}");
  }
}
