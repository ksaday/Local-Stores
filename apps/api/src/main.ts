import "reflect-metadata";
// Must be the first import after reflect-metadata: instrumentation patches
// http/express/pg as they load, so anything loaded before it is never traced.
import "./tracing-bootstrap.js";
import { Logger, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { JsonLogger } from "./infra/observability/logger.js";
import { startMetricsServer } from "./infra/observability/metrics-server.js";
import { initCheckoutMetrics } from "./infra/observability/checkout-metrics.js";
import { initPaymentMetrics } from "./infra/observability/payment-metrics.js";
import { PipelineMetrics } from "./infra/observability/pipeline-metrics.js";
import { ProblemDetailsFilter } from "./common/filters/problem-details.filter.js";
import { ResponseEnvelopeInterceptor } from "./common/interceptors/response-envelope.interceptor.js";
import type { Env } from "./config/env.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Keeps the untouched request bytes on `req.rawBody` alongside the parsed
    // body. Stripe signs the exact bytes it sent, so verification must run
    // over those — a re-serialised body produces identical JSON and an invalid
    // signature.
    //
    // Nest's own option rather than a hand-rolled `express.json({ verify })`:
    // mounting a parser manually makes Nest detect one is already present and
    // skip registering its global one, which silently leaves every other route
    // with no parsed body at all.
    rawBody: true,
  });
  const config = app.get(ConfigService<Env, true>);

  // Swap Nest's own logger for the structured one, so framework lines (route
  // mapping, shutdown, unhandled errors) are JSON too rather than the only
  // prose left in the stream.
  app.useLogger(app.get(JsonLogger));

  app.use(helmet());
  app.use(cookieParser());

  // Image bytes for the local stand-in for a presigned PUT (§13.7). Nest's own
  // parsers handle JSON, urlencoded and text, so an `image/*` body would
  // otherwise never be read at all.
  //
  // `express.raw` and not `express.json`: mounting a *json* parser by hand is
  // what previously made Nest detect one was already present and skip
  // registering its global one, silently leaving every other route with no
  // parsed body. This registers under a different name and leaves that alone.
  //
  // Nothing in the suite covers this file — it is the bootstrap — so the check
  // that JSON bodies still parse was made against a running API, and has to be
  // made that way again if this block changes.
  app.use(
    express.raw({
      type: ["image/jpeg", "image/png", "image/webp", "image/avif"],
      // The signed grant carries the real ceiling; this only stops a body far
      // larger than any grant allows from being buffered to find that out.
      limit: "12mb",
    }),
  );

  // Same-origin by default: the browser talks to the Next.js BFF, which forwards
  // the auth cookie server-side. Only the web origin is allowed, and credentials
  // are never paired with a wildcard (plan §13.6).
  app.enableCors({
    origin: [config.get("WEB_ORIGIN")],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  });

  // Uploaded media, served straight from disk in development.
  //
  // Mounted on `.storage/public` specifically, never on `.storage` itself:
  // the sibling `private/` directory holds delivery proofs and signatures, and
  // `quarantine/` holds files that have not yet passed validation. Serving the
  // parent would publish both.
  //
  // In production MEDIA_BASE_URL points at the CDN and this route goes unused.
  if (!config.get("MEDIA_BASE_URL")) {
    app.useStaticAssets(join(process.cwd(), ".storage", "public"), {
      prefix: "/media/public",
      index: false,
      // These are content-addressed by a server-generated UUID key, so a given
      // URL's bytes never change.
      maxAge: "1y",
      immutable: true,
      setHeaders: (res) => {
        // A stored file must be rendered as its declared type or downloaded —
        // never sniffed into something executable.
        res.setHeader("X-Content-Type-Options", "nosniff");
        // Helmet's default same-origin CORP would stop the storefront from
        // embedding these, since the web app and the media origin differ in
        // every environment. Relaxed here only: these are public,
        // already-validated images whose whole purpose is to be embedded.
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      },
    });
  }

  app.setGlobalPrefix("api");
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.enableShutdownHooks();

  // Metrics on their own port, deliberately.
  //
  // `/metrics` on the main listener would be reachable by anyone who can reach
  // the API, and it describes the inside of the system: route names, latencies,
  // event-loop health. A separate port is simply not routed by the load
  // balancer, which is a stronger boundary than a path nobody links to.
  // Before serving anything, so the checkout ratio has a numerator from the
  // first scrape. See initCheckoutMetrics: an absent completions series makes
  // the alert silent in exactly the total-outage case.
  initCheckoutMetrics();
  // Zero rather than absent, so a flat zero line is distinguishable from a
  // metric nobody wired up. See initPaymentMetrics.
  initPaymentMetrics();

  const pipeline = app.get(PipelineMetrics);
  startMetricsServer(config.get("METRICS_PORT", { infer: true }), app.get(JsonLogger), () =>
    pipeline.refresh(),
  );

  const port = config.get("PORT");
  await app.listen(port);
  app.get(JsonLogger).event("log", "API listening", {
    port,
    env: config.get("NODE_ENV"),
  }, "bootstrap");
}

void bootstrap();
