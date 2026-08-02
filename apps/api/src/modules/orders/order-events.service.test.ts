import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderEventsService, type OrderEvent } from "./order-events.service.js";

let events: OrderEventsService;

const STORE_A = "store-a";
const STORE_B = "store-b";

beforeEach(() => {
  events = new OrderEventsService();
});

function collector() {
  const seen: OrderEvent[] = [];
  return { seen, listener: (event: OrderEvent) => seen.push(event) };
}

function emit(storeId: string, orderNumber = "ORD-1") {
  events.emit({
    type: "order.created",
    storeId,
    orderId: crypto.randomUUID(),
    orderNumber,
    status: "PENDING",
  });
}

describe("delivery", () => {
  it("delivers an event to a subscriber of that store", () => {
    const { seen, listener } = collector();
    events.subscribe(STORE_A, listener);

    emit(STORE_A, "ORD-7");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ orderNumber: "ORD-7", type: "order.created" });
  });

  it("never delivers one store's events to another store's subscriber", () => {
    // The whole tenancy guarantee of the stream. A clerk watching store A must
    // not learn that store B just took an order.
    const a = collector();
    const b = collector();
    events.subscribe(STORE_A, a.listener);
    events.subscribe(STORE_B, b.listener);

    emit(STORE_A);

    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(0);
  });

  it("delivers to every subscriber of the same store", () => {
    // Two clerks on two tablets at one counter.
    const first = collector();
    const second = collector();
    events.subscribe(STORE_A, first.listener);
    events.subscribe(STORE_A, second.listener);

    emit(STORE_A);

    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(1);
  });

  it("stops delivering after unsubscribe", () => {
    const { seen, listener } = collector();
    const unsubscribe = events.subscribe(STORE_A, listener);

    unsubscribe();
    emit(STORE_A);

    expect(seen).toHaveLength(0);
    // The bookkeeping has to go too, or a tablet reconnecting all day leaks a
    // listener per connection.
    expect(events.subscriberCount(STORE_A)).toBe(0);
  });

  it("keeps going when one subscriber throws", () => {
    // A broken client must not be able to stop its colleagues being told, and
    // must never fail the request that produced the event.
    const healthy = collector();
    events.subscribe(STORE_A, () => {
      throw new Error("this listener is broken");
    });
    events.subscribe(STORE_A, healthy.listener);

    expect(() => emit(STORE_A)).not.toThrow();
    expect(healthy.seen).toHaveLength(1);
  });

  it("assigns increasing ids", () => {
    const { seen, listener } = collector();
    events.subscribe(STORE_A, listener);

    emit(STORE_A);
    emit(STORE_A);

    expect(seen[1]!.id).toBeGreaterThan(seen[0]!.id);
  });
});

describe("replay after a dropped connection", () => {
  it("replays only what the client missed", () => {
    // Someone walks through a tunnel with the tablet. On reconnect they should
    // get the orders that arrived while they were gone, and not the ones they
    // already have.
    const first = collector();
    events.subscribe(STORE_A, first.listener);
    emit(STORE_A, "ORD-1");
    emit(STORE_A, "ORD-2");
    const lastSeenId = first.seen[0]!.id;

    const reconnected = collector();
    events.subscribe(STORE_A, reconnected.listener, lastSeenId);

    expect(reconnected.seen.map((e) => e.orderNumber)).toEqual(["ORD-2"]);
  });

  it("replays nothing when the client is already current", () => {
    const { seen, listener } = collector();
    events.subscribe(STORE_A, listener);
    emit(STORE_A);

    const reconnected = collector();
    events.subscribe(STORE_A, reconnected.listener, seen[0]!.id);

    expect(reconnected.seen).toHaveLength(0);
  });

  it("does not replay another store's events", () => {
    emit(STORE_B, "B-1");

    const { seen, listener } = collector();
    events.subscribe(STORE_A, listener, 0);

    expect(seen).toHaveLength(0);
  });

  it("bounds the replay buffer so it cannot grow without limit", () => {
    // Memory whose growth a client controls. A busy shop on a long-lived
    // process would otherwise accumulate every event it ever emitted.
    for (let i = 0; i < 200; i += 1) emit(STORE_A, `ORD-${i}`);

    const { seen, listener } = collector();
    events.subscribe(STORE_A, listener, 0);

    expect(seen.length).toBeLessThanOrEqual(50);
    // What survives is the most recent, which is what a reconnecting client
    // actually needs.
    expect(seen.at(-1)!.orderNumber).toBe("ORD-199");
  });

  it("gives a client that has fallen too far behind whatever is left", () => {
    // Not an error: the queue re-reads from the database on every render, so a
    // partial replay costs efficiency, never correctness.
    for (let i = 0; i < 200; i += 1) emit(STORE_A, `ORD-${i}`);

    const { seen, listener } = collector();
    events.subscribe(STORE_A, listener, 1);

    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("emission discipline", () => {
  it("does not throw when nobody is listening", () => {
    // The common case: no clerk has the queue open. Emitting must never be
    // able to fail the order that produced it.
    expect(() => emit(STORE_A)).not.toThrow();
  });

  it("stamps every event with a timestamp", () => {
    const { seen, listener } = collector();
    events.subscribe(STORE_A, listener);

    const before = Date.now();
    emit(STORE_A);

    expect(new Date(seen[0]!.at).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});
