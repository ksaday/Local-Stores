import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";

export interface OutboxRecord {
  type: string;
  storeId?: string | null;
  /** The order, store or user the event is about. */
  aggregateId?: string | null;
  payload: Record<string, unknown>;
}

/**
 * Writes domain events into the transactional outbox (plan §12.8).
 *
 * The important method is `emitIn`, which takes the *caller's* transaction
 * client. That is the whole point: the event is inserted by the same
 * transaction that made the change, so the two commit or roll back together.
 * There is no window in which an order exists and its event does not, or in
 * which staff are told about an order that never happened.
 *
 * `emit` exists for the handful of callers with nothing to join — it opens its
 * own transaction, and is therefore NOT atomic with anything else. Prefer
 * `emitIn` wherever a transaction is already open.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends an event to the outbox using an existing transaction.
   *
   * Raw INSERT rather than `create()`: Prisma always emits
   * `INSERT ... RETURNING`, and Postgres applies the SELECT policy to the
   * returned row. A store-scoped transaction can write its own event but
   * cannot read the platform-only outbox back, so `create()` would fail.
   */
  async emitIn(tx: Prisma.TransactionClient, record: OutboxRecord): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO outbox_events (type, store_id, aggregate_id, payload)
      VALUES (${record.type}, ${record.storeId ?? null}, ${record.aggregateId ?? null},
              ${JSON.stringify(record.payload)}::jsonb)
    `;
  }

  /**
   * Appends an event in its own transaction.
   *
   * Use only when there is genuinely nothing to be atomic with. Anything that
   * accompanies a database change should use `emitIn` instead.
   */
  async emit(record: OutboxRecord): Promise<void> {
    await this.prisma.withTenant(
      { storeId: record.storeId ?? undefined, isSuperAdmin: !record.storeId },
      (tx) => this.emitIn(tx, record),
    );
  }
}
