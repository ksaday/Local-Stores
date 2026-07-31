import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { AppError } from "../../common/errors/app-error.js";
import { PasswordService } from "./password.service.js";

/** Breach check disabled: these assertions must not depend on a network call. */
const config = {
  get: (key: string) => (key === "PASSWORD_BREACH_CHECK" ? false : undefined),
} as unknown as ConfigService;

const passwords = new PasswordService(config as never);

describe("password hashing", () => {
  it("produces an argon2id hash, not argon2d or argon2i", async () => {
    // Guards the inlined ARGON2ID constant: if the upstream enum value ever
    // shifts, this fails instead of silently downgrading the algorithm.
    const hash = await passwords.hash("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("encodes the configured cost parameters", async () => {
    const hash = await passwords.hash("correct horse battery staple");
    expect(hash).toContain("m=65536,t=3,p=4");
  });

  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await passwords.hash("correct horse battery staple");
    expect(await passwords.verify(hash, "correct horse battery staple")).toBe(true);
    expect(await passwords.verify(hash, "Correct horse battery staple")).toBe(false);
  });

  it("salts — the same password hashes differently each time", async () => {
    const a = await passwords.hash("correct horse battery staple");
    const b = await passwords.hash("correct horse battery staple");
    expect(a).not.toEqual(b);
    expect(await passwords.verify(a, "correct horse battery staple")).toBe(true);
    expect(await passwords.verify(b, "correct horse battery staple")).toBe(true);
  });

  it("returns false rather than throwing on a malformed stored hash", async () => {
    // A corrupted row must be a failed login, not a 500 that confirms the
    // account exists.
    expect(await passwords.verify("not-a-hash", "anything")).toBe(false);
    expect(await passwords.verify("", "anything")).toBe(false);
  });
});

describe("rehash detection", () => {
  it("does not flag a hash made at current parameters", async () => {
    const hash = await passwords.hash("correct horse battery staple");
    expect(passwords.needsRehash(hash)).toBe(false);
  });

  it("flags a hash made at weaker parameters", () => {
    const weak = "$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA";
    expect(passwords.needsRehash(weak)).toBe(true);
  });

  it("flags an unrecognized format so it gets upgraded on next login", () => {
    expect(passwords.needsRehash("$2b$12$bcryptstylehash")).toBe(true);
  });
});

describe("password policy", () => {
  it("rejects passwords under the minimum length", async () => {
    await expect(passwords.assertAcceptable("short1")).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a password containing the email local part", async () => {
    await expect(
      passwords.assertAcceptable("mariabakery2026", "maria@example.com"),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("accepts a long passphrase with no composition rules imposed", async () => {
    // Deliberately no digits or symbols: length is the constraint that matters,
    // and composition rules reliably produce "Passw0rd!".
    await expect(
      passwords.assertAcceptable("the quiet bakery on morse avenue"),
    ).resolves.toBeUndefined();
  });

  it("reports the failing field so the UI can attach the error", async () => {
    try {
      await passwords.assertAcceptable("abc");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("VALIDATION_FAILED");
      expect((err as AppError).fieldErrors?.[0]?.field).toBe("password");
    }
  });
});
