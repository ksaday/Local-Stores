import { z } from "zod";

/**
 * Environment contract. The app refuses to boot if this fails to parse
 * (plan §12.11) — a missing signing key should stop deployment, not surface
 * as a 500 on the first login attempt.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),

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

  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),

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
