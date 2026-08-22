import { startTracingFromEnv } from "../infra/observability/tracing.js";

/** The worker's half of the same trick — see `src/tracing-bootstrap.ts`. */
startTracingFromEnv("bba-worker");
