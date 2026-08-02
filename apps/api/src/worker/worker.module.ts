import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "../config/env.js";
import { PrismaModule } from "../infra/prisma/prisma.module.js";
import { OutboxModule } from "../infra/outbox/outbox.module.js";
import { AuditModule } from "../modules/audit/audit.module.js";
import { OrdersModule } from "../modules/orders/orders.module.js";
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
    OutboxModule,
    AuditModule,
    OrdersModule,
  ],
  providers: [OutboxRelay, WorkerScheduler],
})
export class WorkerModule {}
