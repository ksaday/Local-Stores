import { Injectable, Logger } from "@nestjs/common";
import { OrdersService } from "../modules/orders/orders.service.js";
import { OutboxRelay } from "./outbox-relay.js";

export interface ScheduledJob {
  name: string;
  everyMs: number;
  run: () => Promise<string>;
}

/**
 * The worker's scheduled jobs (plan §12.9).
 *
 * Deliberately plain `setInterval` rather than BullMQ repeatable jobs for this
 * slice: every job here is idempotent and cheap, so the guarantees BullMQ adds
 * — retries, dead-lettering, distributed locks — cost more than they buy. The
 * outbox already provides at-least-once delivery, which was the actual gap.
 *
 * The job that genuinely needs a distributed lock is the one to watch: with two
 * workers running, both would sweep. That is currently safe only because every
 * job is idempotent, and it is the thing to fix before running a second worker.
 */
@Injectable()
export class WorkerScheduler {
  private readonly logger = new Logger(WorkerScheduler.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly orders: OrdersService,
    private readonly relay: OutboxRelay,
  ) {}

  jobs(): ScheduledJob[] {
    return [
      {
        // Fast, because it is the loop that carries live order updates to
        // every staff screen. A second of latency here is a second of a clerk
        // staring at a queue that is already out of date.
        name: "outbox-relay",
        everyMs: 1_000,
        run: async () => {
          const published = await this.relay.runOnce();
          return published > 0 ? `published ${published}` : "";
        },
      },
      {
        // Releases stock held by checkouts nobody completed. Without it an
        // abandoned basket holds the last loaf off the shelf indefinitely.
        name: "order-expiry",
        everyMs: 60_000,
        run: async () => {
          const expired = await this.orders.expireStaleOrders();
          return expired > 0 ? `expired ${expired}` : "";
        },
      },
      {
        name: "dead-letter-check",
        everyMs: 300_000,
        run: async () => {
          const parked = await this.relay.deadLettered();
          // Warned about rather than silently tolerated: parked events mean
          // staff screens have stopped hearing about something.
          if (parked > 0) this.logger.warn(`${parked} outbox event(s) parked after repeated failures`);
          return "";
        },
      },
    ];
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const job of this.jobs()) {
      // Each job re-arms only after it finishes, so a slow pass cannot stack
      // overlapping runs on top of itself.
      const tick = async () => {
        if (!this.running) return;
        try {
          const outcome = await job.run();
          if (outcome) this.logger.log(`${job.name}: ${outcome}`);
        } catch (err) {
          // One failing pass must never stop the schedule.
          this.logger.error(`${job.name} failed: ${String(err)}`);
        }
        if (this.running) this.timers.push(setTimeout(tick, job.everyMs));
      };
      this.timers.push(setTimeout(tick, job.everyMs));
    }

    this.logger.log(`Scheduled ${this.jobs().length} job(s)`);
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }
}
