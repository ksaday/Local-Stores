import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { validateEnv } from "./config/env.js";
import { PrismaModule } from "./infra/prisma/prisma.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { HealthModule } from "./modules/health/health.module.js";
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
    AuthModule,
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
