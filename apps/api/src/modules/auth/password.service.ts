import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { AppError } from "../../common/errors/app-error.js";
import type { Env } from "../../config/env.js";

/**
 * `Algorithm.Argon2id` from @node-rs/argon2 is an ambient const enum, which
 * cannot be imported under `isolatedModules`. Inlined with its upstream value;
 * a test asserts produced hashes actually carry the `$argon2id$` marker, so a
 * value drift in the library fails loudly rather than silently downgrading us
 * to argon2d.
 */
const ARGON2ID = 2;

/**
 * argon2id at the parameters in plan §13.1. These are a deliberate
 * memory-hardness/latency tradeoff, not defaults — raising memoryCost is the
 * lever if hardware gets cheaper, and any change needs a rehash-on-login path
 * (see `needsRehash`).
 */
const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

const MIN_PASSWORD_LENGTH = 10;

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_PARAMS);
  }

  /**
   * Constant-time by construction inside argon2. Returns false rather than
   * throwing on a malformed stored hash, so a corrupted row is a failed login
   * rather than a 500 that reveals the account exists.
   */
  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext, ARGON2_PARAMS);
    } catch {
      return false;
    }
  }

  /**
   * True when a stored hash was made with weaker parameters than current policy.
   * Callers rehash transparently on successful login (plan §13.1) — raising
   * parameters otherwise only protects accounts created after the change.
   */
  needsRehash(storedHash: string): boolean {
    const m = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    if (!m) return true; // unrecognized format — rehash on next successful login
    const [, memory, time, parallelism] = m;
    return (
      Number(memory) < ARGON2_PARAMS.memoryCost ||
      Number(time) < ARGON2_PARAMS.timeCost ||
      Number(parallelism) < ARGON2_PARAMS.parallelism
    );
  }

  /**
   * Policy per plan §13.1: length plus a breach check, deliberately *without*
   * composition rules. Forcing a symbol and a digit reliably produces
   * "Passw0rd!" — length and not-already-leaked are the constraints that
   * actually correlate with resisting a real attack.
   */
  async assertAcceptable(plaintext: string, email?: string): Promise<void> {
    const errors: { field: string; code: string; message: string }[] = [];

    if (plaintext.length < MIN_PASSWORD_LENGTH) {
      errors.push({
        field: "password",
        code: "TOO_SHORT",
        message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    if (email && plaintext.toLowerCase().includes(email.split("@")[0]!.toLowerCase())) {
      errors.push({
        field: "password",
        code: "CONTAINS_EMAIL",
        message: "Your password cannot contain your email address.",
      });
    }

    if (errors.length === 0 && (await this.isBreached(plaintext))) {
      errors.push({
        field: "password",
        code: "BREACHED",
        message:
          "This password has appeared in a known data breach. Please choose a different one.",
      });
    }

    if (errors.length > 0) {
      throw AppError.validation("That password cannot be used.", errors);
    }
  }

  /**
   * Have I Been Pwned range API, k-anonymity: only the first 5 characters of the
   * SHA-1 leave this process, so the password itself is never transmitted and
   * the service cannot learn which candidate was checked.
   *
   * Fails *open* on network error — a third-party outage must not block every
   * registration on the platform. The tradeoff is deliberate: this is a
   * defense-in-depth control, not the primary one.
   */
  private async isBreached(plaintext: string): Promise<boolean> {
    if (!this.config.get("PASSWORD_BREACH_CHECK", { infer: true })) return false;

    const sha1 = createHash("sha1").update(plaintext).digest("hex").toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true" },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;

      const body = await res.text();
      for (const line of body.split("\n")) {
        const candidate = line.split(":")[0]?.trim();
        if (!candidate || candidate.length !== suffix.length) continue;
        // Constant-time compare so response timing can't be used to probe
        // which suffix matched.
        if (
          timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(suffix, "utf8"))
        ) {
          return true;
        }
      }
      return false;
    } catch (err) {
      this.logger.warn(
        `Breach check unavailable, allowing password: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
