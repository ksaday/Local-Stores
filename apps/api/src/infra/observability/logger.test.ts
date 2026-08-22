import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../../common/context/request-context.js";
import { JsonLogger, loggerOptionsFrom, type JsonLoggerOptions } from "./logger.js";

function capture(options: Omit<JsonLoggerOptions, "write"> = {}) {
  const lines: string[] = [];
  const logger = new JsonLogger({ ...options, write: (l) => lines.push(l) });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("structured logging", () => {
  it("writes one JSON object per line", () => {
    const { logger, parsed } = capture();
    logger.log("a thing happened", "Catalog");

    const [entry] = parsed();
    expect(entry).toMatchObject({ level: "INFO", message: "a thing happened", context: "Catalog" });
    expect(typeof entry!.time).toBe("string");
  });

  it("picks up the request id without being handed it", () => {
    // The point of the ambient context: no call site threads this through, and
    // every line a request produces can still be found from the id on the
    // error page a shop is looking at.
    const { logger, parsed } = capture();
    runWithRequestContext(
      { requestId: "req_abc", userId: "u1", storeId: "s1", isSuperAdmin: false },
      () => logger.log("inside a request"),
    );

    expect(parsed()[0]).toMatchObject({ requestId: "req_abc", userId: "u1", storeId: "s1" });
  });

  it("leaves identity out when there is no request", () => {
    const { logger, parsed } = capture();
    logger.log("from the worker");

    const entry = parsed()[0]!;
    expect(entry.requestId).toBeUndefined();
    expect(entry.userId).toBeUndefined();
  });

  it("logs an error's message and never the error itself", () => {
    // A database or HTTP client error carries the failing request, and that
    // request carries a cookie header. Serialising the whole object is how a
    // live session token ends up in a log aggregator.
    const { logger, lines } = capture();
    const err = Object.assign(new Error("connect ECONNREFUSED"), {
      request: { headers: { cookie: "bba_at=super-secret-token" } },
    });

    logger.error(err, undefined, "Db");

    expect(lines[0]).toContain("connect ECONNREFUSED");
    expect(lines[0]).not.toContain("super-secret-token");
    expect(lines[0]).not.toContain("cookie");
  });

  it("keeps a stack when Nest passes one", () => {
    const { logger, parsed } = capture();
    logger.error("it broke", "Error: it broke\n    at somewhere", "Orders");
    expect(parsed()[0]!.stack).toContain("at somewhere");
  });

  it("survives a circular object rather than throwing inside the logger", () => {
    // A logger that can throw turns a small fault into an outage.
    const { logger, parsed } = capture();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;

    expect(() => logger.event("log", "cyclic", { loop })).not.toThrow();
    expect(JSON.stringify(parsed()[0])).toContain("[circular]");
  });

  it("serialises a bigint, which JSON cannot", () => {
    // Money and counts come back from Postgres as bigint often enough that
    // this would otherwise throw on a perfectly ordinary log line.
    const { logger, parsed } = capture();
    logger.event("log", "counted", { total: 42n });
    expect(parsed()[0]!.total).toBe("42");
  });

  it("drops anything below the threshold", () => {
    const { logger, lines } = capture({ minLevel: "warn" });
    logger.debug("noise");
    logger.log("also noise");
    logger.warn("kept");
    logger.error("kept too");

    expect(lines).toHaveLength(2);
  });

  it("writes prose when asked, for a developer's terminal", () => {
    const { logger, lines } = capture({ pretty: true });
    logger.log("readable", "Catalog");
    expect(lines[0]).toBe("INFO [Catalog] readable");
    expect(() => JSON.parse(lines[0]!)).toThrow();
  });

  it("defaults to JSON in production and prose everywhere else", () => {
    expect(loggerOptionsFrom({ NODE_ENV: "production" })).toEqual({ minLevel: "log", pretty: false });
    expect(loggerOptionsFrom({ NODE_ENV: "development" })).toEqual({ minLevel: "debug", pretty: true });
  });

  it("lets the environment override the format, so production's format runs locally", () => {
    // A log pipeline only ever exercised by deploying to it is not tested. This
    // is how the JSON shape gets checked on a laptop.
    expect(loggerOptionsFrom({ NODE_ENV: "development", LOG_FORMAT: "json" }).pretty).toBe(false);
    expect(loggerOptionsFrom({ NODE_ENV: "production", LOG_FORMAT: "pretty" }).pretty).toBe(true);
    expect(loggerOptionsFrom({ NODE_ENV: "production", LOG_LEVEL: "debug" }).minLevel).toBe("debug");
  });
});
