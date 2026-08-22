import type { LoggerService, LogLevel } from "@nestjs/common";
import { getRequestContext } from "../../common/context/request-context.js";

/**
 * Structured logging (plan §14.5, NFR-OPS-01).
 *
 * One JSON object per line, so a log aggregator can index fields rather than
 * regex over prose. Nest's default logger writes for a human reading a
 * terminal, which is the wrong audience once the terminal is CloudWatch.
 *
 * Every line carries the `requestId` from the ambient request context, without
 * any call site passing it. That is the whole reason the context exists: a shop
 * that reports "it said something went wrong at 10:42" can hand over the id
 * from the error page and it finds every line the request produced, across the
 * BFF hop and into the worker.
 *
 * Hand-written rather than pino, for the same reason the CSV writer is: the
 * shape is small and fully specified, the redaction rule below is specific to
 * this application, and the alternative brings a transport and a config surface
 * to solve a problem that is forty lines of JSON.
 */

/** Ordered, so a level threshold is a comparison rather than a lookup table. */
const LEVELS = ["debug", "verbose", "log", "warn", "error", "fatal"] as const;
type Level = (typeof LEVELS)[number];

/** What each level is called once it is being read by a machine. */
const SEVERITY: Record<Level, string> = {
  debug: "DEBUG",
  verbose: "DEBUG",
  log: "INFO",
  warn: "WARN",
  error: "ERROR",
  fatal: "FATAL",
};

export interface JsonLoggerOptions {
  /** Anything below this is dropped. */
  minLevel?: Level;
  /** Human-readable lines instead of JSON. For a developer's terminal. */
  pretty?: boolean;
  /** Injected so tests can read what was written. */
  write?: (line: string) => void;
}

export class JsonLogger implements LoggerService {
  private readonly minIndex: number;
  private readonly pretty: boolean;
  private readonly write: (line: string) => void;

  constructor(options: JsonLoggerOptions = {}) {
    this.minIndex = LEVELS.indexOf(options.minLevel ?? "log");
    this.pretty = options.pretty ?? false;
    this.write = options.write ?? ((line) => process.stdout.write(line + "\n"));
  }

  log(message: unknown, context?: string) { this.emit("log", message, context); }
  warn(message: unknown, context?: string) { this.emit("warn", message, context); }
  debug(message: unknown, context?: string) { this.emit("debug", message, context); }
  verbose(message: unknown, context?: string) { this.emit("verbose", message, context); }
  fatal(message: unknown, context?: string) { this.emit("fatal", message, context); }

  /**
   * Nest calls this as `error(message, stack?, context?)`, so the middle
   * argument is a stack string rather than a context name.
   */
  error(message: unknown, stack?: string, context?: string) {
    this.emit("error", message, context, stack ? { stack } : undefined);
  }

  /** A log line with fields of its own — a request completing, a job finishing. */
  event(level: Level, message: string, fields: Record<string, unknown>, context?: string): void {
    this.emit(level, message, context, fields);
  }

  private emit(
    level: Level,
    message: unknown,
    context?: string,
    fields?: Record<string, unknown>,
  ): void {
    if (LEVELS.indexOf(level) < this.minIndex) return;

    const ctx = getRequestContext();
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: SEVERITY[level],
      message: render(message),
      ...(context ? { context } : {}),
      // Identity, not personal data: ids that join lines together. A name or an
      // email would make the log itself something to protect.
      ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx?.userId ? { userId: ctx.userId } : {}),
      ...(ctx?.storeId ? { storeId: ctx.storeId } : {}),
      ...(fields ?? {}),
    };

    if (this.pretty) {
      const tail = fields ? " " + JSON.stringify(fields) : "";
      this.write(`${entry.level} ${context ? `[${context}] ` : ""}${entry.message}${tail}`);
      return;
    }

    this.write(safeStringify(entry));
  }
}

/**
 * A message as a string, without ever serialising a whole Error.
 *
 * An error thrown by a database or HTTP client usually carries the failing
 * request, and that request usually carries a `cookie` header. Taking only the
 * message is what keeps a live session token out of the log — the accessibility
 * gate leaked one into CI output in exactly this way before it was fixed.
 */
function render(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return String(message);
  }
}

/** Survives a circular reference rather than throwing inside the logger. */
function safeStringify(entry: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(entry, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  });
}

/**
 * How a deployment should log, from the environment.
 *
 * NODE_ENV picks the defaults; LOG_FORMAT and LOG_LEVEL override them. The
 * override exists so the shipping format can be run locally — a log pipeline
 * only ever exercised by deploying to it is not one anybody has tested.
 */
export function loggerOptionsFrom(env: {
  NODE_ENV?: string;
  LOG_FORMAT?: "json" | "pretty";
  LOG_LEVEL?: Level;
}): { minLevel: Level; pretty: boolean } {
  const production = env.NODE_ENV === "production";
  return {
    minLevel: env.LOG_LEVEL ?? (production ? "log" : "debug"),
    pretty: env.LOG_FORMAT ? env.LOG_FORMAT === "pretty" : !production,
  };
}

export type { Level as LogLevelName };
export type { LogLevel };
