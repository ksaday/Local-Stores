import { sampledByTraceId } from "@bba/shared";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor, Span } from "@opentelemetry/sdk-trace-base";
import type { Context } from "@opentelemetry/api";

/**
 * Keeps every trace that went wrong, and a small deterministic slice of the
 * rest (docs/ops/observability.md §4).
 *
 * ## Why this is not a Sampler
 *
 * OpenTelemetry's `Sampler` interface runs at span *start*, and the policy
 * §4 asks for — all errors, all slow requests, a low rate of everything else —
 * cannot be evaluated then. Nothing knows at the first line of a request
 * whether it will throw or take four seconds. A head sampler set to 5% keeps
 * 5% of errors, which is the opposite of what anybody wants from a trace: the
 * interesting ones are precisely the ones it throws away.
 *
 * So the decision moves to the end, in a `SpanProcessor` that holds a trace's
 * spans until it can see how the request turned out.
 *
 * ## Why it buffers by trace and not by span
 *
 * Deciding span by span produces traces with holes — an HTTP span kept while
 * the query that made it slow is dropped, which is worse than no trace at all
 * because it looks complete. Spans are held by trace id and released together.
 *
 * The release trigger is the end of this process's SERVER span, not the root
 * span: with the BFF in front, the root lives in another process and would
 * never arrive. Every child (a query, a middleware) ends before the server span
 * that encloses it, so by then the trace is whole as far as this process is
 * concerned.
 *
 * ## Why the baseline rate is a hash and not a coin flip
 *
 * The one thing a per-process tail decision cannot do is agree with another
 * process. If the BFF rolled its own dice and this rolled its own, the two
 * halves of a trace would disagree half the time and the baseline sample would
 * be full of traces missing an end.
 *
 * Hashing the trace id fixes that without any coordination: the trace id is
 * identical in both processes, so both compute the same answer and either both
 * keep it or both drop it. That is what makes the low-rate baseline usable —
 * it yields whole traces rather than halves.
 *
 * Errors and slow requests are still decided locally, so those *can* be partial
 * if one process keeps a trace the other dropped. That is an acceptable trade:
 * half of a failing trace, with the failing half guaranteed present, beats a
 * complete trace of a request nobody cares about. Consistent whole-trace
 * sampling in every case is what a collector's tail sampler is for, and this is
 * the useful 90% of it without one.
 */

export interface TailSamplerOptions {
  /** Fraction of ordinary traces to keep, 0–1. Errors and slow ones ignore it. */
  baselineRatio: number;
  /** A server span at or above this many milliseconds is always kept. */
  slowRequestMs: number;
  /**
   * Safety valve. Spans are held in memory until their server span ends, and a
   * trace whose server span never arrives would otherwise be held forever.
   */
  maxBufferedSpans: number;
}

export class TailSampler implements SpanProcessor {
  private readonly buffers = new Map<string, ReadableSpan[]>();
  private buffered = 0;

  constructor(
    private readonly downstream: SpanProcessor,
    private readonly options: TailSamplerOptions,
  ) {}

  onStart(_span: Span, _parentContext: Context): void {
    // Nothing to do: the decision needs an ended span.
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;

    const held = this.buffers.get(traceId) ?? [];
    held.push(span);
    this.buffers.set(traceId, held);
    this.buffered += 1;

    // The request this process served has finished, so the trace is as complete
    // as it will get here.
    if (span.kind === SpanKind.SERVER) {
      this.release(traceId);
      return;
    }

    // A trace whose server span never ends — a crash mid-request, or work
    // started outside any request — must not accumulate. Dropping the oldest
    // incomplete trace is deliberate: keeping it would mean exporting a
    // fragment with no request around it, which is not diagnosable anyway.
    if (this.buffered > this.options.maxBufferedSpans) this.evictOldest();
  }

  /** Decides for the whole trace and forwards it, or drops it. */
  private release(traceId: string): void {
    const spans = this.buffers.get(traceId);
    if (!spans) return;

    this.buffers.delete(traceId);
    this.buffered -= spans.length;

    if (!this.keep(spans, traceId)) return;
    for (const span of spans) this.downstream.onEnd(span);
  }

  private keep(spans: ReadableSpan[], traceId: string): boolean {
    // Any failure anywhere in the trace, not just on the server span: a query
    // that threw and was retried successfully is exactly the thing worth
    // seeing, and the request around it looks fine from the outside.
    if (spans.some((s) => s.status.code === SpanStatusCode.ERROR)) return true;

    const server = spans.find((s) => s.kind === SpanKind.SERVER);
    if (server && durationMs(server) >= this.options.slowRequestMs) return true;

    return sampledByTraceId(traceId, this.options.baselineRatio);
  }

  private evictOldest(): void {
    // Map preserves insertion order, so the first key is the trace that has
    // been waiting longest.
    const oldest = this.buffers.keys().next();
    if (oldest.done) return;

    const spans = this.buffers.get(oldest.value) ?? [];
    this.buffers.delete(oldest.value);
    this.buffered -= spans.length;
  }

  async forceFlush(): Promise<void> {
    // Anything still held has no server span and is not diagnosable; release
    // the memory rather than exporting fragments.
    this.buffers.clear();
    this.buffered = 0;
    await this.downstream.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    await this.downstream.shutdown();
  }
}

/** A span's wall-clock duration in milliseconds. */
export function durationMs(span: ReadableSpan): number {
  const [seconds, nanos] = span.duration;
  return seconds * 1000 + nanos / 1e6;
}

