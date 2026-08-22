import { diag, DiagLogLevel, SpanKind, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { TailSampler } from "./tail-sampler.js";

/**
 * Distributed tracing (docs/ops/observability.md §4).
 *
 * The span that earns its keep is BFF → API → Postgres. A slow page can be a
 * slow query or a slow proxy, and from either end alone those look identical —
 * the API's own metrics say it answered in 40ms, the browser says the page took
 * two seconds, and nothing in between is visible. The trace is the only thing
 * that shows where the time went.
 *
 * ## Off unless an endpoint is configured
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` unset means no SDK, no instrumentation, no
 * monkey-patching of http or pg. Tracing that half-runs — recording spans and
 * dropping them — costs real overhead for nothing, and every test run and
 * developer laptop would pay it. `OTEL_TRACES_CONSOLE=1` prints spans instead,
 * which is how this gets exercised without standing up a collector.
 *
 * ## Started before anything else
 *
 * Instrumentation works by patching modules as they load, so the SDK has to
 * start before `http`, `express` or `pg` are imported by anything that matters.
 * That is why this is called at the very top of `main.ts`, before the Nest
 * imports, rather than from inside a module the way everything else is wired.
 */

let sdk: NodeSDK | undefined;

export interface TracingOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /** OTLP/HTTP collector endpoint. Absent disables tracing entirely. */
  endpoint?: string;
  /** Print spans to stdout instead of exporting. For local inspection. */
  console?: boolean;
  baselineRatio: number;
  slowRequestMs: number;
}

export function startTracing(options: TracingOptions): boolean {
  if (sdk) return true;
  if (!options.endpoint && !options.console) return false;

  // Otherwise a misconfigured collector prints a stack trace per export, for
  // every batch, forever — which is how tracing takes down the log pipeline it
  // was meant to complement.
  diag.setLogger(
    { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, verbose: () => {} },
    DiagLogLevel.NONE,
  );

  const exporter: SpanExporter = options.console
    ? new ConsoleSpanExporter()
    : new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` });

  // Console output is wanted immediately when a developer is watching; a real
  // collector wants batching.
  const downstream: SpanProcessor = options.console
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.0.0",
      "deployment.environment.name": options.environment ?? "development",
    }),

    // Everything is recorded; what to keep is decided when the request is over.
    // See TailSampler for why the sampling decision cannot live here.
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      new TailSampler(downstream, {
        baselineRatio: options.baselineRatio,
        slowRequestMs: options.slowRequestMs,
        maxBufferedSpans: 10_000,
      }),
    ],

    // Named individually rather than via auto-instrumentations-node. That
    // package patches several dozen libraries, most of which this service does
    // not use, and each one is startup cost and a surface that can break on an
    // upgrade. These three are the hop the plan actually asks about.
    instrumentations: [
      new HttpInstrumentation({
        // A readiness probe every few seconds would otherwise be most of the
        // trace volume and has never told anybody anything.
        ignoreIncomingRequestHook: (req) => (req.url ?? "").includes("/health/"),
      }),
      new ExpressInstrumentation(),
      // No database instrumentation package here, deliberately.
      //
      // `@opentelemetry/instrumentation-pg` patches the `pg` module, which this
      // codebase does not depend on at all — Prisma reaches Postgres through
      // its own query engine. Installing it produced traces with no database
      // spans whatsoever, which is how that was found.
      //
      // `@prisma/instrumentation` at the version matching Prisma 5.22 bundles
      // OpenTelemetry SDK 1.x and crashes outright against the 2.x SDK here
      // (`parentTracer.getSpanLimits is not a function`). Pinning the whole
      // tracing stack to an older OpenTelemetry line to satisfy it is a poor
      // trade for one span type.
      //
      // Database spans come from `withTenantContext` instead, which every one
      // of the 240 tenant-scoped call sites already funnels through. See there
      // for why a transaction is the right unit to measure in this codebase.
    ],
  });

  sdk.start();
  return true;
}

/**
 * Starts tracing from the raw environment, for the entry files.
 *
 * Reads `process.env` rather than `ConfigService`, because this has to run
 * before Nest exists — the instrumentation patches `http`, `express` and `pg`
 * as they are loaded, so anything that imports them first is never traced.
 */
export function startTracingFromEnv(serviceName: string): boolean {
  return startTracing({
    serviceName,
    serviceVersion: process.env.npm_package_version,
    environment: process.env.NODE_ENV,
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    console: process.env.OTEL_TRACES_CONSOLE === "1" || process.env.OTEL_TRACES_CONSOLE === "true",
    baselineRatio: Number(process.env.OTEL_BASELINE_RATIO ?? 0.05),
    slowRequestMs: Number(process.env.OTEL_SLOW_REQUEST_MS ?? 600),
  });
}

export async function stopTracing(): Promise<void> {
  await sdk?.shutdown().catch(() => undefined);
  sdk = undefined;
}

/**
 * The current trace and span ids, for putting on a log line.
 *
 * This is what makes a trace and a log searchable as one thing: an error line
 * carries the trace id, and the trace shows the query that produced it. Without
 * it the two are separate systems a human has to join by timestamp, which works
 * until there is more than one request per second.
 *
 * Returns nothing when tracing is off, so log lines simply do not gain the
 * fields rather than gaining empty ones.
 */
export function currentTraceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};

  const context = span.spanContext();
  if (!context.traceId || context.traceId === "00000000000000000000000000000000") return {};

  return { traceId: context.traceId, spanId: context.spanId };
}

/**
 * Puts the tenant on the request's span.
 *
 * `store_id` and the route template only. Never a customer's name, email or
 * address: a trace backend is a third-party system with its own access model,
 * and §4 is explicit that identifying data does not go there.
 */
export function annotateRequestSpan(attributes: { storeId?: string; route?: string }): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  if (attributes.storeId) span.setAttribute("bba.store_id", attributes.storeId);
  if (attributes.route) span.setAttribute("http.route", attributes.route);
}

export { SpanKind };
