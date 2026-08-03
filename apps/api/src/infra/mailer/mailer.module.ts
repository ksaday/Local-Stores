import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../config/env.js";
import { QueueModule } from "../queue/queue.module.js";
import { LogMailer, MailDelivery, Mailer } from "./mailer.js";
import { QueueMailer } from "./queue.mailer.js";

/**
 * Both ends of outbound mail.
 *
 * `Mailer` is what callers inject, and it always queues — in the API and in
 * the worker alike. Uniform on purpose: dunning runs inside the worker, and
 * letting it deliver inline while everything else queued would give the one
 * message that matters most, a shop about to go offline, the weakest retry
 * story of the lot.
 *
 * `MailDelivery` is resolved only by the worker's processor. It is present in
 * the API's graph too, unused, because one module describing both ends is
 * easier to follow than two that have to be kept in step.
 */
@Global()
@Module({
  imports: [QueueModule],
  providers: [
    { provide: Mailer, useClass: QueueMailer },
    {
      provide: MailDelivery,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new LogMailer(config.get("NODE_ENV", { infer: true })),
    },
  ],
  exports: [Mailer, MailDelivery],
})
export class MailerModule {}
