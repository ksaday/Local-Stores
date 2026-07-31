#!/usr/bin/env node
/**
 * Prints a fresh Ed25519 keypair in the single-line PEM form the env schema
 * expects. Generate a distinct pair per environment; production keys belong in
 * Secrets Manager, never in a file in the repo.
 *
 *   npm run keygen
 */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const oneLine = (key, type) =>
  key.export({ type, format: "pem" }).toString().trim().replace(/\n/g, "\\n");

console.log(`JWT_PRIVATE_KEY="${oneLine(privateKey, "pkcs8")}"`);
console.log(`JWT_PUBLIC_KEY="${oneLine(publicKey, "spki")}"`);
