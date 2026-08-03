import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MailProcessor } from "./mail-processor.js";
import { OutboxRelay } from "./outbox-relay.js";
import { WorkerScheduler } from "./scheduler.js";
import { WorkerModule } from "./worker.module.js";

/**
 * The worker entrypoint (plan §12.9).
 *
 * Same codebase as the API, different entrypoint: it boots an application
 * *context* rather than an HTTP server, so it gets the full DI graph and every
 * domain service without opening a port.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger("worker");
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(logger);

  const scheduler = app.get(WorkerScheduler);
  const relay = app.get(OutboxRelay);
  const mail = app.get(MailProcessor);
  scheduler.start();
  mail.start();
  logger.log("Worker started");

  // Stop taking new work, finish what is in flight, then close connections.
  // A relay killed mid-batch would leave events unpublished but not lost —
  // they stay in the outbox and go out on the next start.
  const shutdown = async (signal: string) => {
    logger.log(`${signal} received, shutting down`);
    scheduler.stop();
    // Before the relay, because a message half-delivered is worse than one
    // still queued: closing the worker lets in-flight sends finish first.
    await mail.stop();
    await relay.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void bootstrap();
