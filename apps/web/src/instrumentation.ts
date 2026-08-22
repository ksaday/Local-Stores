import { registerOTel } from "@vercel/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { BffTailSampler } from "./lib/tracing";

/**
 * Tracing for the BFF (docs/ops/observability.md §4).
 *
 * This half is the reason §4 exists. The API can prove it answered in 40ms and
 * the browser can prove the page took two seconds, and neither can say where
 * the other 1,960ms went — rendering, the proxy hop, or waiting on a call the
 * API never logged because it never arrived. Only a span on this side closes
 * that gap.
 *
 * Next calls `register()` once per server runtime before handling any request,
 * which is early enough for the fetch instrumentation to patch what it needs.
 *
 * Off unless an endpoint is configured, exactly as on the API: recording spans
 * nobody collects is overhead with no upside, and every `next dev` would pay
 * it.
 *
 * ## NEXT_OTEL_VERBOSE=1 is required, and its absence is silent
 *
 * Next suppresses `fetch` spans unless that variable is set, and the outbound
 * call to the API is the single span this file exists to produce. Without it
 * everything still *works*: the BFF traces its render, the API traces its
 * request, both look healthy, and they are two unrelated traces with no hop
 * between them. Nothing warns about it — the failure is a missing edge, not an
 * error — so it is set in the deployment config and stated here.
 */
export function register(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const toConsole = process.env.OTEL_TRACES_CONSOLE === "1" || process.env.OTEL_TRACES_CONSOLE === "true";
  if (!endpoint && !toConsole) return;

  // The edge runtime has no OTLP exporter and no long-lived process to batch
  // in; registering there produces warnings and no spans.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const exporter: SpanExporter = toConsole
    ? new ConsoleSpanExporter()
    : new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });

  const downstream: SpanProcessor = toConsole
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);

  // `@vercel/otel` propagates trace context only to deployment URLs by default
  // and requires everything else to be named explicitly. That default is right:
  // a `traceparent` header sent to an arbitrary third party leaks the shape of
  // internal request flow to whoever receives it. So the allowlist is exactly
  // one entry — our own API — rather than a wildcard.
  //
  // This is also the thing that makes BFF and API spans one trace instead of
  // two: without it both sides trace correctly and separately, which looks
  // almost right and answers nothing.
  const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";

  registerOTel({
    serviceName: "bba-web",
    instrumentationConfig: { fetch: { propagateContextUrls: [apiOrigin] } },
    spanProcessors: [
      new BffTailSampler(downstream, {
        baselineRatio: Number(process.env.OTEL_BASELINE_RATIO ?? 0.05),
        slowRequestMs: Number(process.env.OTEL_SLOW_REQUEST_MS ?? 600),
        maxBufferedSpans: 10_000,
      }),
    ],
  });
}
