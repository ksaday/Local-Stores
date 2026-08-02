import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { Env } from "../../config/env.js";
import { OrderEventsService, type OrderEventType } from "./order-events.service.js";

/** The channel the worker's outbox relay publishes onto. */
export const ORDER_EVENTS_CHANNEL = "bba:order-events";

interface PublishedEvent {
  id: string;
  type: string;
  storeId: string | null;
  payload: { orderId?: string; orderNumber?: string; status?: string };
}

/**
 * Feeds the local SSE fan-out from Redis.
 *
 * This is what makes the live order queue correct with more than one API
 * process. Previously a service emitted straight into an in-process bus, so a
 * clerk connected to instance A never saw an order confirmed on instance B,
 * and nothing survived a restart.
 *
 * Now the path is: domain transaction writes the outbox → the worker's relay
 * publishes to Redis → every API instance receives it here and fans out to
 * whichever SSE clients it happens to be holding.
 *
 * Redis pub/sub is fire-and-forget, which is fine precisely because these
 * events carry no authority: they only prompt a client to re-read the queue
 * from the database. A dropped message costs a stale screen until the next
 * event or the polling fallback — never wrong data.
 */
@Injectable()
export class OrderEventsBridge implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderEventsBridge.name);
  private subscriber: Redis | null = null;

  constructor(
    private readonly events: OrderEventsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get("REDIS_URL", { infer: true });

    // A dedicated connection: a Redis client in subscriber mode cannot run
    // ordinary commands, so sharing one with the rest of the app would break
    // both.
    this.subscriber = new Redis(url, {
      // Without this a Redis outage takes the API down with it. The queue
      // falls back to polling on its own, so degrading is the right answer.
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    this.subscriber.on("error", (err) => {
      this.logger.warn(`Order events Redis error: ${err.message}`);
    });

    try {
      await this.subscriber.connect();
      await this.subscriber.subscribe(ORDER_EVENTS_CHANNEL);
      this.subscriber.on("message", (_channel, message) => this.onMessage(message));
      this.logger.log(`Subscribed to ${ORDER_EVENTS_CHANNEL}`);
    } catch (err) {
      // Deliberately not fatal. The API serves every request without Redis;
      // only live updates degrade, and the client already handles that.
      this.logger.warn(`Live order events unavailable: ${String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
  }

  private onMessage(message: string): void {
    let event: PublishedEvent;
    try {
      event = JSON.parse(message) as PublishedEvent;
    } catch {
      this.logger.warn("Discarded an unparseable order event");
      return;
    }

    if (!event.storeId) return;

    this.events.emit({
      type: event.type as OrderEventType,
      storeId: event.storeId,
      orderId: event.payload?.orderId ?? "",
      orderNumber: event.payload?.orderNumber ?? "",
      status: event.payload?.status ?? "",
    });
  }
}
