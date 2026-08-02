import "reflect-metadata";
import { Logger, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "node:path";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
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

  app.use(helmet());
  app.use(cookieParser());

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

  const port = config.get("PORT");
  await app.listen(port);
  new Logger("bootstrap").log(`API listening on :${port} (${config.get("NODE_ENV")})`);
}

void bootstrap();
