import { Injectable, Logger } from "@nestjs/common";
import { BillingService } from "../modules/billing/billing.service.js";
import { MailQueue } from "../infra/queue/queue.module.js";
import { DunningService } from "../modules/billing/dunning.service.js";
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
 * Still plain `setInterval`, even now that BullMQ is in the codebase for mail.
 * The difference is what the two carry: a queue job is one message to one
 * person and losing it loses that message, whereas these are sweeps over
 * whatever the database currently says. A missed pass costs nothing, because
 * the next one recomputes the same answer. Retries and dead-lettering have
 * nothing to retry here.
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
    private readonly billing: BillingService,
    private readonly dunning: DunningService,
    private readonly mail: MailQueue,
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
        // Hourly rather than by the minute: the grace period is measured in
        // days, and taking a shop offline is not something to do eagerly.
        name: "billing-grace-period",
        everyMs: 3_600_000,
        run: async () => {
          const suspended = await this.billing.suspendExpiredGracePeriods();
          return suspended > 0 ? `suspended ${suspended} unpaid store(s)` : "";
        },
      },
      {
        // Runs on the same hourly beat as the suspension sweep, and
        // deliberately after it in the list: when a store's grace period runs
        // out, the pass that takes it offline is followed by the pass that
        // says so, rather than the owner finding out an hour later.
        name: "billing-dunning",
        everyMs: 3_600_000,
        run: async () => {
          const sent = await this.dunning.run();
          return sent > 0 ? `sent ${sent} dunning email(s)` : "";
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

          // Mail that exhausted every retry. Worth its own line: a failed
          // outbox event costs a stale screen, whereas a failed email is a
          // password reset or a suspension warning that never arrived.
          const undelivered = await this.mail.deadLettered();
          if (undelivered > 0) {
            this.logger.error(`${undelivered} email(s) failed every attempt and were not delivered`);
          }
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
