import { Injectable, Logger } from "@nestjs/common";

export type OrderEventType =
  | "order.created"
  | "order.status_changed"
  | "order.payment_recorded";

export interface OrderEvent {
  /** Monotonic per process. Doubles as the SSE `id:` for `Last-Event-Id`. */
  id: number;
  type: OrderEventType;
  storeId: string;
  orderId: string;
  orderNumber: string;
  status: string;
  at: string;
}

type Listener = (event: OrderEvent) => void;

/**
 * In-process pub/sub for order activity, feeding the staff SSE stream.
 *
 * **This is deliberately not the design in plan §12.8.** That calls for domain
 * events written to an `outbox_events` table inside the transaction, relayed
 * by a worker — which survives a process restart and works across instances.
 * `apps/worker` does not exist yet, so this carries the same event shapes
 * in-memory, behind an interface the relay can take over.
 *
 * What that costs today, stated plainly so nobody discovers it in production:
 *
 * - **Single instance only.** Two API processes behind a load balancer would
 *   each see only their own writes, so a clerk connected to instance A would
 *   miss an order confirmed on instance B.
 * - **Nothing survives a restart.** The replay buffer is memory.
 *
 * Neither breaks correctness — the queue is authoritative from the database on
 * every render, and the stream only ever prompts a refresh. The failure mode is
 * a stale screen until the next action or the polling fallback, not wrong data.
 */
@Injectable()
export class OrderEventsService {
  private readonly logger = new Logger(OrderEventsService.name);

  private nextId = 1;
  private readonly listeners = new Map<string, Set<Listener>>();

  /**
   * Recent events per store, for replaying after a dropped connection.
   *
   * Bounded because it is memory a client controls the growth of: a busy shop
   * on a long-lived process would otherwise accumulate forever. A client that
   * has fallen further behind than this reconnects without replay and gets a
   * full refresh instead, which is correct if less efficient.
   */
  private readonly recent = new Map<string, OrderEvent[]>();
  private static readonly REPLAY_LIMIT = 50;

  /**
   * Publishes an event to everyone watching that store.
   *
   * MUST be called after the transaction commits, never inside it. Emitting
   * from within means a subscriber can be told about an order that then rolls
   * back, and the clerk's screen shows work that does not exist.
   */
  emit(event: Omit<OrderEvent, "id" | "at">): void {
    const full: OrderEvent = { ...event, id: this.nextId++, at: new Date().toISOString() };

    const buffer = this.recent.get(full.storeId) ?? [];
    buffer.push(full);
    if (buffer.length > OrderEventsService.REPLAY_LIMIT) {
      buffer.splice(0, buffer.length - OrderEventsService.REPLAY_LIMIT);
    }
    this.recent.set(full.storeId, buffer);

    for (const listener of this.listeners.get(full.storeId) ?? []) {
      try {
        listener(full);
      } catch (err) {
        // One broken subscriber must not stop the others from being told, and
        // must never fail the request that produced the event.
        this.logger.warn(`SSE listener threw: ${String(err)}`);
      }
    }
  }

  /**
   * Subscribes to a store's events. Returns the unsubscribe function.
   *
   * `afterId` replays anything missed during a reconnect, which is what makes
   * `Last-Event-Id` worth honouring: without it a clerk who walked through a
   * tunnel comes back to a screen that silently missed two orders.
   */
  subscribe(storeId: string, listener: Listener, afterId?: number): () => void {
    if (afterId !== undefined) {
      for (const event of this.recent.get(storeId) ?? []) {
        if (event.id > afterId) listener(event);
      }
    }

    const set = this.listeners.get(storeId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(storeId, set);

    return () => {
      const current = this.listeners.get(storeId);
      if (!current) return;
      current.delete(listener);
      // Drop the empty set rather than leaving one per store that has ever
      // been watched.
      if (current.size === 0) this.listeners.delete(storeId);
    };
  }

  /** Watchers per store, for the health endpoint. */
  subscriberCount(storeId: string): number {
    return this.listeners.get(storeId)?.size ?? 0;
  }
}
