import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { getRequestContext } from "../../common/context/request-context.js";

export type AuditSeverity = "LOW" | "MEDIUM" | "HIGH";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string;
  severity?: AuditSeverity;
  storeId?: string;
  before?: unknown;
  after?: unknown;
  /** Overrides the actor from request context — used by scheduled jobs. */
  actorUserId?: string | null;
}

/**
 * Field names whose values must never reach the audit log.
 *
 * The log is long-lived, widely readable within a tenant, and deliberately
 * un-editable — so a secret written here cannot be redacted later. Matching is
 * on the key, case-insensitively, at any depth.
 */
const REDACTED_KEYS = [
  "password",
  "passwordhash",
  "tokenhash",
  "token",
  "refreshtoken",
  "accesstoken",
  "secret",
  "mfatotpsecret",
  "authorization",
  "apikey",
  "clientsecret",
  "stripeaccountid",
];

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append an entry. Never throws for LOW/MEDIUM — a failed audit write should
   * not fail a product action.
   *
   * HIGH severity is different and throws deliberately. Those are the
   * privilege changes, store suspensions, and ownership transfers where "we
   * cannot say who did this" is a worse outcome than the action not happening.
   * If this starts failing, that is itself an incident and should be loud.
   */
  async record(entry: AuditEntry): Promise<void> {
    const ctx = getRequestContext();
    const severity = entry.severity ?? "MEDIUM";

    const actorUserId = entry.actorUserId !== undefined ? entry.actorUserId : (ctx?.userId ?? null);
    const storeId = entry.storeId ?? ctx?.storeId ?? null;
    const before = entry.before === undefined ? null : JSON.stringify(redact(entry.before));
    const after = entry.after === undefined ? null : JSON.stringify(redact(entry.after));

    try {
      // Raw INSERT rather than prisma.create: Prisma always emits
      // `INSERT ... RETURNING`, and Postgres applies the SELECT policy to the
      // returned row. Audit rows are deliberately written outside the writer's
      // read scope — an entry recorded with no store context, or by an actor
      // who cannot read that store, is exactly the case that matters — so the
      // read-back fails even though the append is permitted.
      //
      // Not returning the row is free here; nothing needs it.
      await this.prisma.unscoped().$executeRaw`
        INSERT INTO audit_logs
          (id, actor_user_id, store_id, severity, action, entity_type, entity_id,
           before, after, ip, user_agent, request_id, created_at)
        VALUES (
          gen_random_uuid()::text,
          ${actorUserId},
          ${storeId},
          ${severity}::"AuditSeverity",
          ${entry.action},
          ${entry.entityType},
          ${entry.entityId ?? null},
          ${before}::jsonb,
          ${after}::jsonb,
          ${ctx?.ip ?? null},
          ${ctx?.userAgent ?? null},
          ${ctx?.requestId ?? null},
          now()
        )
      `;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Audit write failed (${severity} ${entry.action} on ${entry.entityType}): ${message}`,
      );
      if (severity === "HIGH") throw err;
    }
  }
}

/**
 * Recursively strips sensitive values, replacing them with a marker so the
 * shape of the change is still legible — a reviewer can see that a password
 * was changed without learning what it was.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  // Bound the walk: audit payloads are records, not deep object graphs, and an
  // unbounded recursion here would be a denial-of-service on the write path.
  if (depth > 6) return "[truncated]";

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.includes(key.toLowerCase())
        ? "[redacted]"
        : redact(val, depth + 1);
    }
    return out;
  }

  return value;
}
