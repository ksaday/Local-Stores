import { startTracingFromEnv } from "./infra/observability/tracing.js";

/**
 * Imported first by `main.ts`, and doing its work on import rather than
 * exporting something to call.
 *
 * That is the whole point. ES module imports are hoisted above every statement,
 * so a `startTracing()` call at the top of `bootstrap()` would run long after
 * `http`, `express` and `pg` had already been loaded by the Nest imports — and
 * instrumentation that patches a module after everything holds a reference to
 * it silently traces nothing. Import order is the only ordering guarantee
 * available here, so the side effect belongs in a module.
 */
startTracingFromEnv("bba-api");
