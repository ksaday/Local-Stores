import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "../config/env.js";
import { MailerModule } from "../infra/mailer/mailer.module.js";
import { PrismaModule } from "../infra/prisma/prisma.module.js";
import { OutboxModule } from "../infra/outbox/outbox.module.js";
import { AuditModule } from "../modules/audit/audit.module.js";
import { BillingModule } from "../modules/billing/billing.module.js";
import { OrdersModule } from "../modules/orders/orders.module.js";
import { MediaModule } from "../modules/media/media.module.js";
import { MailProcessor } from "./mail-processor.js";
import { MediaProcessor } from "./media-processor.js";
import { OutboxRelay } from "./outbox-relay.js";
import { WorkerScheduler } from "./scheduler.js";

/**
 * The worker's module graph.
 *
 * Imports the API's own domain modules rather than reimplementing anything, so
 * the expiry sweeper runs the exact state machine, permission checks and stock
 * ledger writes that a clerk's tap does (plan §12.9). Business rules exist in
 * one place.
 *
 * Nothing HTTP is imported: no controllers, no guards, no CORS. The worker
 * has no listening socket.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    PrismaModule,
    // @Global, but a global module still has to be imported once per root
    // module — and the worker has its own root, separate from the API's.
    MailerModule,
    OutboxModule,
    AuditModule,
    OrdersModule,
    BillingModule,
    MediaModule,
  ],
  providers: [MailProcessor, MediaProcessor, OutboxRelay, WorkerScheduler],
})
export class WorkerModule {}
