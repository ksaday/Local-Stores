import { defineWorkspace } from "vitest/config";

/**
 * Without this, a root `vitest run` globs every test file but applies none of
 * the per-package configuration — so apps/api's SWC transform is skipped,
 * `emitDecoratorMetadata` is absent, and NestJS DI silently injects undefined.
 * Each entry points at a package so its own vitest.config.ts is honoured.
 */
export default defineWorkspace(["packages/*", "apps/api"]);
