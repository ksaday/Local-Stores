import { sampledByTraceId } from "@bba/shared";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * The BFF's half of the sampling policy.
 *
 * The same shape as the API's `TailSampler` and, importantly, the same
 * *decision*: both call the shared `sampledByTraceId`, so for an ordinary trace
 * the two processes independently reach the same answer and a baseline trace
 * arrives whole rather than stopping at the proxy. That agreement is the reason
 * the hash is shared code rather than a number each side picks.
 *
 * A separate class rather than the API's, because the two disagree about what
 * ends a trace. In the API the request is over when its SERVER span ends. Here
 * the SERVER span is the page render, and the outbound call to the API — the
 * one hop this exists to measure — is a CLIENT span that finishes *before* it.
 * Same trigger, different meaning, and sharing one class would mean a flag that
 * makes it do two jobs.
 */

export interface BffTailSamplerOptions {
  baselineRatio: number;
  slowRequestMs: number;
  maxBufferedSpans: number;
}

export class BffTailSampler implements SpanProcessor {
  private readonly buffers = new Map<string, ReadableSpan[]>();
  private buffered = 0;

  constructor(
    private readonly downstream: SpanProcessor,
    private readonly options: BffTailSamplerOptions,
  ) {}

  onStart(_span: Span, _parentContext: Context): void {
    // The decision needs a finished span.
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    const held = this.buffers.get(traceId) ?? [];
    held.push(span);
    this.buffers.set(traceId, held);
    this.buffered += 1;

    if (span.kind === SpanKind.SERVER) {
      this.release(traceId);
      return;
    }

    if (this.buffered > this.options.maxBufferedSpans) this.evictOldest();
  }

  private release(traceId: string): void {
    const spans = this.buffers.get(traceId);
    if (!spans) return;

    this.buffers.delete(traceId);
    this.buffered -= spans.length;

    if (!this.keep(spans, traceId)) return;
    for (const span of spans) this.downstream.onEnd(span);
  }

  private keep(spans: ReadableSpan[], traceId: string): boolean {
    // Any span, not just the render: a failed call to the API is the thing most
    // worth having a trace of, and a page that renders an error state around it
    // succeeds.
    if (spans.some((s) => s.status.code === SpanStatusCode.ERROR)) return true;

    const server = spans.find((s) => s.kind === SpanKind.SERVER);
    if (server && durationMs(server) >= this.options.slowRequestMs) return true;

    return sampledByTraceId(traceId, this.options.baselineRatio);
  }

  private evictOldest(): void {
    const oldest = this.buffers.keys().next();
    if (oldest.done) return;

    const spans = this.buffers.get(oldest.value) ?? [];
    this.buffers.delete(oldest.value);
    this.buffered -= spans.length;
  }

  async forceFlush(): Promise<void> {
    this.buffers.clear();
    this.buffered = 0;
    await this.downstream.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    await this.downstream.shutdown();
  }
}

function durationMs(span: ReadableSpan): number {
  const [seconds, nanos] = span.duration;
  return seconds * 1000 + nanos / 1e6;
}
