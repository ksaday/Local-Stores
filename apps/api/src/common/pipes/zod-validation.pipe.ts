import { Injectable, PipeTransform } from "@nestjs/common";
import type { ZodTypeAny, ZodError } from "zod";
import { AppError } from "../errors/app-error.js";

/**
 * Validates a payload against a zod schema from packages/shared, so the API and
 * the frontend validate against one definition (plan NFR-MNT-02).
 *
 * Parsing is strict-by-construction: schemas are `.strict()` at the definition
 * site so unexpected keys are rejected rather than silently dropped. That is the
 * mass-assignment defense in plan §13.4 — store_id, status, and price-authoritative
 * fields must never be settable because a client sent them.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw AppError.validation("The request payload is invalid.", toFieldErrors(result.error));
  }
}

function toFieldErrors(error: ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
}

/** Convenience factory: `@Body(zodBody(CreateStoreSchema))`. */
export function zodBody(schema: ZodTypeAny): ZodValidationPipe {
  return new ZodValidationPipe(schema);
}
