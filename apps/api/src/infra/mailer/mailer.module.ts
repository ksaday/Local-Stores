import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../config/env.js";
import { LogMailer, Mailer } from "./mailer.js";

@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new LogMailer(config.get("NODE_ENV", { infer: true })),
    },
  ],
  exports: [Mailer],
})
export class MailerModule {}
