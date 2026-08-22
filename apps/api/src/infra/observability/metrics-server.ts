import { createServer, type Server } from "node:http";
import type { JsonLogger } from "./logger.js";
import { scrape } from "./metrics.js";

/**
 * The scrape endpoint, on a port of its own.
 *
 * Not a Nest route. `/metrics` on the main listener is reachable by anybody who
 * can reach the API, and what it exposes is a description of the inside of the
 * system: every route name, its latency distribution, the event loop's health,
 * how much memory the process is using. None of that should be public, and
 * "nobody links to it" is not a control.
 *
 * A separate port is one the load balancer simply does not route. The scraper
 * reaches it inside the VPC; the internet has no path to it at all.
 *
 * It answers `/metrics` and nothing else — a 404 for everything, so it cannot
 * be mistaken for a general-purpose listener.
 */
export function startMetricsServer(port: number, logger: JsonLogger): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }

    scrape()
      .then(({ body, contentType }) => {
        res.writeHead(200, { "content-type": contentType }).end(body);
      })
      .catch((err: unknown) => {
        // Only the message: an error here still goes to the same log stream as
        // everything else, and whole error objects carry request headers.
        logger.event("error", "metrics scrape failed", {
          reason: err instanceof Error ? err.message : String(err),
        }, "metrics");
        res.writeHead(500).end();
      });
  });

  // Never keep the process alive for the sake of the metrics port: shutdown
  // should be decided by the API listener, not by this.
  server.unref();

  server.listen(port, () => {
    logger.event("log", "metrics listening", { port }, "metrics");
  });

  return server;
}
