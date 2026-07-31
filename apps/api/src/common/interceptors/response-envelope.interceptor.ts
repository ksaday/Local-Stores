import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { map, type Observable } from "rxjs";

/** Opt a route out of the envelope (SSE streams, file downloads, print docs). */
export const RAW_RESPONSE = Symbol("RAW_RESPONSE");

interface Paginated {
  data: unknown;
  meta?: unknown;
  links?: unknown;
}

function isAlreadyEnveloped(v: unknown): v is Paginated {
  return typeof v === "object" && v !== null && "data" in v;
}

/**
 * Wraps handler returns as `{ data: ... }` per plan §10.1, leaving responses
 * that already carry `data`/`meta` (paginated collections) untouched.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler();
    if (Reflect.getMetadata(RAW_RESPONSE, handler)) return next.handle();

    return next.handle().pipe(
      map((body) => {
        if (body === undefined || body === null) return body;
        if (isAlreadyEnveloped(body)) return body;
        return { data: body };
      }),
    );
  }
}
