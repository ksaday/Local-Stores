import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { JsonLogger, loggerOptionsFrom } from "../infra/observability/logger.js";
import { startMetricsServer } from "../infra/observability/metrics-server.js";
import { initPaymentMetrics } from "../infra/observability/payment-metrics.js";
import { MailProcessor } from "./mail-processor.js";
import { MediaProcessor } from "./media-processor.js";
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
  // The same structured logger as the API. A JSON stream from one process and
  // prose from the other is not one log: the aggregator can index requestId on
  // half of it, and the half it cannot index is the half where the pipeline
  // faults show up.
  const logger = new JsonLogger(
    loggerOptionsFrom({
      NODE_ENV: process.env.NODE_ENV,
      LOG_FORMAT: process.env.LOG_FORMAT as "json" | "pretty" | undefined,
      LOG_LEVEL: process.env.LOG_LEVEL as never,
    }),
  );
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(logger);

  // The worker needs a scrape endpoint of its own. `expired_while_paid` is
  // incremented here, by the expiry sweep, and a counter in a process nobody
  // scrapes is a counter that does not exist — which would have made the most
  // consequential cause of an unreconciled payment the one nobody could see.
  //
  // Its own port so both processes can run on one machine in development. In
  // production they are separate containers and can share a number.
  initPaymentMetrics();
  startMetricsServer(Number(process.env.WORKER_METRICS_PORT ?? 9465), logger);

  const scheduler = app.get(WorkerScheduler);
  const relay = app.get(OutboxRelay);
  const mail = app.get(MailProcessor);
  const media = app.get(MediaProcessor);
  scheduler.start();
  mail.start();
  media.start();
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
    await media.stop();
    await relay.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void bootstrap();
