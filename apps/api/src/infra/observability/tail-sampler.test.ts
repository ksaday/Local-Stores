import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { TailSampler } from "./tail-sampler.js";

/** A span with only the fields the sampler reads. */
function span(options: {
  traceId: string;
  kind?: SpanKind;
  error?: boolean;
  durationMs?: number;
  name?: string;
}): ReadableSpan {
  const ms = options.durationMs ?? 1;
  return {
    name: options.name ?? "span",
    kind: options.kind ?? SpanKind.INTERNAL,
    status: { code: options.error ? SpanStatusCode.ERROR : SpanStatusCode.UNSET },
    duration: [Math.floor(ms / 1000), (ms % 1000) * 1e6],
    spanContext: () => ({ traceId: options.traceId, spanId: "0000000000000001", traceFlags: 1 }),
  } as unknown as ReadableSpan;
}

/** A downstream processor that records what it was handed. */
function collector() {
  const exported: ReadableSpan[] = [];
  const processor: SpanProcessor = {
    onStart: () => {},
    onEnd: (s) => exported.push(s),
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  return { processor, exported, names: () => exported.map((s) => s.name) };
}

/** A trace id the baseline hash keeps, and one it drops, at a 50% ratio. */
const KEPT = "0000000000000000000000000000000f".slice(0, 24) + "00000001";
const DROPPED = "0000000000000000000000000000000f".slice(0, 24) + "fffffffe";

function sampler(downstream: SpanProcessor, over: Partial<{ baselineRatio: number; slowRequestMs: number; maxBufferedSpans: number }> = {}) {
  return new TailSampler(downstream, {
    baselineRatio: 0,
    slowRequestMs: 600,
    maxBufferedSpans: 100,
    ...over,
  });
}

describe("keeping the traces worth keeping", () => {
  it("holds child spans until the request finishes", async () => {
    // Exporting a child immediately would mean the decision had already been
    // made for it, which is the whole thing this avoids.
    const { processor, exported } = collector();
    const tail = sampler(processor);

    tail.onEnd(span({ traceId: KEPT, name: "SELECT orders" }));
    expect(exported).toHaveLength(0);

    tail.onEnd(span({ traceId: KEPT, kind: SpanKind.SERVER, error: true, name: "GET /orders" }));
    expect(exported).toHaveLength(2);
  });

  it("keeps a whole trace, never a piece of one", async () => {
    // A trace with holes is worse than no trace: it looks complete, and the
    // query that explains the latency is the piece most likely to be missing.
    const { processor, names } = collector();
    const tail = sampler(processor);

    tail.onEnd(span({ traceId: KEPT, name: "middleware" }));
    tail.onEnd(span({ traceId: KEPT, name: "SELECT orders" }));
    tail.onEnd(span({ traceId: KEPT, kind: SpanKind.SERVER, error: true, name: "GET /orders" }));

    expect(names()).toEqual(["middleware", "SELECT orders", "GET /orders"]);
  });

  it("keeps a trace whose error was on a child, not the request", async () => {
    // A query that threw and was retried leaves the request looking fine from
    // the outside, and is exactly what somebody would want to see.
    const { processor, exported } = collector();
    const tail = sampler(processor);

    tail.onEnd(span({ traceId: DROPPED, error: true, name: "SELECT orders" }));
    tail.onEnd(span({ traceId: DROPPED, kind: SpanKind.SERVER, name: "GET /orders" }));

    expect(exported).toHaveLength(2);
  });

  it("keeps a slow request even when nothing failed", async () => {
    const { processor, exported } = collector();
    const tail = sampler(processor, { slowRequestMs: 600 });

    tail.onEnd(span({ traceId: DROPPED, kind: SpanKind.SERVER, durationMs: 900 }));

    expect(exported).toHaveLength(1);
  });

  it("drops an ordinary fast request outside the baseline", async () => {
    const { processor, exported } = collector();
    const tail = sampler(processor);

    tail.onEnd(span({ traceId: DROPPED, name: "SELECT orders" }));
    tail.onEnd(span({ traceId: DROPPED, kind: SpanKind.SERVER, durationMs: 12 }));

    expect(exported).toHaveLength(0);
  });

  it("keeps an ordinary request that falls inside the baseline", async () => {
    const { processor, exported } = collector();
    const tail = sampler(processor, { baselineRatio: 1 });

    tail.onEnd(span({ traceId: DROPPED, kind: SpanKind.SERVER, durationMs: 12 }));

    expect(exported).toHaveLength(1);
  });

  it("does not grow without limit when a server span never arrives", async () => {
    // A request that crashes mid-flight, or background work with no request
    // around it. Without the cap these accumulate for the life of the process.
    const { processor, exported } = collector();
    const tail = sampler(processor, { maxBufferedSpans: 10 });

    for (let i = 0; i < 50; i += 1) {
      tail.onEnd(span({ traceId: `${i}`.padStart(32, "0"), name: `orphan-${i}` }));
    }

    // Nothing exported — none of them completed — and nothing retained either.
    expect(exported).toHaveLength(0);
    await tail.forceFlush();
    expect(exported).toHaveLength(0);
  });

  it("separates traces that interleave", async () => {
    // Two requests in flight at once is the normal case, not an edge case.
    const { processor, names } = collector();
    const tail = sampler(processor);

    tail.onEnd(span({ traceId: KEPT, name: "a-child" }));
    tail.onEnd(span({ traceId: DROPPED, name: "b-child" }));
    tail.onEnd(span({ traceId: DROPPED, kind: SpanKind.SERVER, name: "b-request" }));
    tail.onEnd(span({ traceId: KEPT, kind: SpanKind.SERVER, error: true, name: "a-request" }));

    // b was ordinary and outside the baseline; a failed.
    expect(names()).toEqual(["a-child", "a-request"]);
  });
});
