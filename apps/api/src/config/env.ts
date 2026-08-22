import { z } from "zod";

/**
 * Environment contract. The app refuses to boot if this fails to parse
 * (plan §12.11) — a missing signing key should stop deployment, not surface
 * as a 500 on the first login attempt.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  /**
   * The Prometheus scrape port. Separate from PORT on purpose: the load
   * balancer routes one and not the other, so metrics are reachable from
   * inside the network and from nowhere else.
   */
  METRICS_PORT: z.coerce.number().int().positive().default(9464),

  /**
   * Log format. Defaults to prose locally and JSON in production, which is
   * almost always what you want — but it is a setting rather than an inference
   * so the shipping format can be exercised on a laptop. A log pipeline that
   * has only ever been tested by deploying to it is not tested.
   */
  LOG_FORMAT: z.enum(["json", "pretty"]).optional(),
  LOG_LEVEL: z.enum(["debug", "verbose", "log", "warn", "error"]).optional(),

  DATABASE_URL: z.string().url(),
  /**
   * The RLS-restricted role. Tests and any code verifying tenant isolation must
   * connect as this, never as the migration superuser — Postgres bypasses RLS
   * for superusers, which would make the isolation suite pass for the wrong reason.
   */
  DATABASE_URL_APP: z.string().url().optional(),

  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  /**
   * Ed25519 keys for access-token signing, PKCS#8 / SPKI PEM.
   * Generated per environment and stored in a secrets manager, never in the repo.
   */
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_ISSUER: z.string().default("bba"),
  JWT_AUDIENCE: z.string().default("bba-api"),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),

  COOKIE_DOMAIN: z.string().optional(),
  /** Cookies go httpOnly+SameSite=Lax always; Secure is dropped only for local http. */
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // 3100, matching .claude/launch.json and CI. The default is what unset
  // environments fall back to, and it builds every link in outbound mail — so
  // Next's own default of 3000 here would send real warnings to a dead port.
  WEB_ORIGIN: z.string().url().default("http://localhost:3100"),

  /**
   * Public base URL for uploaded media.
   *
   * Defaults to this API, which serves `.storage/public` in development. In
   * production this points at the CDN in front of the object store, and the
   * API stops serving files entirely. It must NOT default to WEB_ORIGIN — the
   * files live next to the API, and the web app has no route that serves them.
   */
  MEDIA_BASE_URL: z.string().url().optional(),

  /**
   * Key material for encrypting TOTP secrets at rest. Any length — it is
   * SHA-256 derived before use. In production this comes from Secrets Manager.
   */
  MFA_ENCRYPTION_KEY: z.string().min(16).default("dev-only-mfa-key-change-in-production"),

  /**
   * Stripe. Optional so the app runs without payments configured — a store can
   * still take cash, which is the entire Phase 7 experience. When absent, card
   * checkout is not offered rather than failing at the point of payment.
   */
  STRIPE_SECRET_KEY: z.string().startsWith("sk_").optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  /**
   * Verifies that a webhook really came from Stripe. Without it any caller who
   * finds the endpoint could mark orders paid, so the handler refuses every
   * request when this is unset rather than trusting the body.
   */
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /** Disables the outbound k-anonymity breach check in offline/test environments. */
  PASSWORD_BREACH_CHECK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return parsed.data;
}
