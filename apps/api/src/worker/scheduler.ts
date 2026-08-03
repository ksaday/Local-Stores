import { Injectable, Logger } from "@nestjs/common";
import { BillingService } from "../modules/billing/billing.service.js";
import { MailQueue, MediaQueue } from "../infra/queue/queue.module.js";
import { DunningService } from "../modules/billing/dunning.service.js";
import { LowStockAlerts } from "../modules/inventory/low-stock-alerts.service.js";
import { OrdersService } from "../modules/orders/orders.service.js";
import { JobLease } from "./job-lease.service.js";
import { OutboxRelay } from "./outbox-relay.js";

export interface ScheduledJob {
  name: string;
  everyMs: number;
  /**
   * Whether only one worker in the fleet may run each pass.
   *
   * Off for work that is safe — or better — done by several at once. The
   * outbox relay claims rows with `FOR UPDATE SKIP LOCKED`, so two workers
   * take disjoint batches and drain twice as fast; serialising it would turn
   * a benefit into a bottleneck.
   */
  exclusive?: boolean;
  run: () => Promise<string>;
}

/**
 * How stale the last claim must be before another may be made.
 *
 * A little under the interval, because every worker's timer drifts: demanding
 * the full interval would let a worker that woke a few milliseconds early lose
 * the claim, skip its pass, and stretch an hourly sweep towards two hours.
 */
function claimWindow(everyMs: number): number {
  return Math.floor(everyMs * 0.9);
}

/**
 * The worker's scheduled jobs (plan §12.9).
 *
 * Still plain `setInterval`, even now that BullMQ is in the codebase for mail.
 * The difference is what the two carry: a queue job is one message to one
 * person and losing it loses that message, whereas these are sweeps over
 * whatever the database currently says. A missed pass costs nothing, because
 * the next one recomputes the same answer.
 *
 * Every worker keeps its own timers and they all wake together; the ones marked
 * `exclusive` race for a lease and exactly one wins the pass. That is what
 * makes a second worker safe to run — see `JobLease` for why it is a lease and
 * not a lock.
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
    private readonly mediaQueue: MediaQueue,
    private readonly lowStock: LowStockAlerts,
    private readonly lease: JobLease,
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
        // Suspending is idempotent, but two workers would write two audit
        // entries and two "store suspended" lines for one event.
        exclusive: true,
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
        // The one that is not merely untidy when doubled: both workers would
        // send before either recorded, and the unique index stops the second
        // *record*, not the second email.
        exclusive: true,
        run: async () => {
          const sent = await this.dunning.run();
          return sent > 0 ? `sent ${sent} dunning email(s)` : "";
        },
      },
      {
        // Daily, and the interval is the throttle: the lease means one pass
        // per day across the fleet, so nobody is emailed twice about the same
        // shelf. A digest, not an alert per line — a shop that sells out of six
        // things on a Saturday does not need six emails.
        name: "inventory-low-stock",
        everyMs: 86_400_000,
        exclusive: true,
        run: async () => {
          const notified = await this.lowStock.run();
          return notified > 0 ? `low-stock digest to ${notified} store(s)` : "";
        },
      },
      {
        name: "dead-letter-check",
        everyMs: 300_000,
        // Nothing but logging, and one copy of a warning is what makes it
        // legible.
        exclusive: true,
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

          // An image an owner uploaded and is still waiting to see appear.
          const unprocessed = await this.mediaQueue.deadLettered();
          if (unprocessed > 0) {
            this.logger.error(`${unprocessed} image(s) failed every attempt and remain unprocessed`);
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
          // Another worker got this pass. Not worth a log line: with two
          // workers this is the expected outcome half the time.
          if (job.exclusive && !(await this.lease.claim(job.name, claimWindow(job.everyMs)))) {
            if (this.running) this.timers.push(setTimeout(tick, job.everyMs));
            return;
          }

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
