import "reflect-metadata";
import { Logger, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { ProblemDetailsFilter } from "./common/filters/problem-details.filter.js";
import { ResponseEnvelopeInterceptor } from "./common/interceptors/response-envelope.interceptor.js";
import type { Env } from "./config/env.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
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
