import { Global, Module } from "@nestjs/common";
import { OutboxService } from "./outbox.service.js";

/**
 * Global because almost every domain transaction has an event to record, and
 * threading an import through every module would add ceremony without adding
 * clarity.
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
