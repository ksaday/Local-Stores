import { Global, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../config/env.js";
import { PrismaService } from "./prisma.service.js";

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      /**
       * Connects as the RLS-restricted role, not as the schema owner.
       *
       * This matters more than it looks. `DATABASE_URL` is the migration
       * identity — it owns the tables, and on most local setups it is a
       * superuser. **Superusers bypass row-level security entirely**, even
       * with `FORCE ROW LEVEL SECURITY` set. An API running on that
       * connection has every policy in the schema switched off: cross-tenant
       * isolation, customer-owned carts, guest order tokens, all of it. The
       * queries still succeed, the tests still pass (they connect as
       * `bba_app` explicitly), and nothing anywhere reports a problem.
       *
       * So the runtime uses `DATABASE_URL_APP` and migrations use
       * `DATABASE_URL`. They are different identities on purpose.
       */
      useFactory: (config: ConfigService<Env, true>) => {
        const logger = new Logger("PrismaModule");
        const appUrl = config.get("DATABASE_URL_APP", { infer: true });
        const nodeEnv = config.get("NODE_ENV", { infer: true });

        if (!appUrl) {
          // Refusing to boot is the right call outside development: serving
          // requests with RLS inert is worse than not serving them.
          const message =
            "DATABASE_URL_APP is not set. The API would connect as the schema owner, " +
            "which bypasses row-level security and disables every tenant isolation policy.";
          if (nodeEnv === "production") throw new Error(message);
          logger.error(`${message} Falling back to DATABASE_URL — DO NOT ship this.`);
          return new PrismaService();
        }

        return new PrismaService({ datasources: { db: { url: appUrl } } });
      },
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
