import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { Env } from "../config/env.js";
import { PrismaService } from "../infra/prisma/prisma.service.js";
import { ORDER_EVENTS_CHANNEL } from "../modules/orders/order-events.bridge.js";

interface OutboxRow {
  id: bigint;
  type: string;
  store_id: string | null;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

/** How many events one pass will publish. Bounded so a backlog drains steadily. */
const BATCH_SIZE = 100;

/**
 * Past this, an event is parked rather than retried forever.
 *
 * Without a ceiling one permanently poisonous row blocks every event behind it,
 * which for an order queue means the screens quietly stop updating and nobody
 * knows why.
 */
const MAX_ATTEMPTS = 10;

/**
 * Publishes outbox events to Redis, in order, exactly once per successful pass.
 *
 * The relay half of the transactional outbox (plan §12.8). Domain code writes
 * events inside its own transaction; this reads them out and publishes them,
 * which is what decouples "the order committed" from "the broker was reachable".
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly publisher: Redis;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.publisher = new Redis(config.get("REDIS_URL", { infer: true }), {
      maxRetriesPerRequest: null,
    });
  }

  /**
   * Publishes one batch. Returns how many events were sent.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes this safe to run in more than one
   * worker: each process takes a disjoint set of rows rather than contending
   * for the same ones or publishing them twice.
   *
   * Ordered by id, which is why the outbox key is a BIGSERIAL — staff being
   * shown "confirmed" before "placed" would be nonsense.
   */
  async runOnce(): Promise<number> {
    return this.prisma.withTenant({ isSuperAdmin: true }, async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, type, store_id, aggregate_id, payload, attempts
        FROM outbox_events
        WHERE published_at IS NULL AND attempts < ${MAX_ATTEMPTS}
        ORDER BY id
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return 0;

      let published = 0;
      for (const row of rows) {
        try {
          await this.publisher.publish(
            ORDER_EVENTS_CHANNEL,
            JSON.stringify({
              id: row.id.toString(),
              type: row.type,
              storeId: row.store_id,
              aggregateId: row.aggregate_id,
              payload: row.payload,
            }),
          );

          await tx.$executeRaw`
            UPDATE outbox_events SET published_at = now() WHERE id = ${row.id}
          `;
          published += 1;
        } catch (err) {
          // Recorded on the row and retried next pass. The batch continues:
          // one unpublishable event must not hold up the rest.
          await tx.$executeRaw`
            UPDATE outbox_events
            SET attempts = attempts + 1, last_error = ${String(err).slice(0, 500)}
            WHERE id = ${row.id}
          `;
          this.logger.warn(`Could not publish outbox event ${row.id}: ${String(err)}`);
        }
      }

      return published;
    });
  }

  /** Events parked after too many failures, for the platform health screen. */
  async deadLettered(): Promise<number> {
    const [row] = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM outbox_events
        WHERE published_at IS NULL AND attempts >= ${MAX_ATTEMPTS}
      `,
    );
    return Number(row?.count ?? 0);
  }

  async close(): Promise<void> {
    await this.publisher.quit().catch(() => undefined);
  }
}
