import { resolve } from "node:path";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// NestJS DI reads constructor parameter types from `emitDecoratorMetadata`,
// which esbuild (vitest's default transformer) does not emit. SWC does, so
// tests that construct a Nest module resolve their dependencies correctly.
// Without this, DI silently fails with "Nest can't resolve dependencies".
export default defineConfig({
  resolve: {
    alias: {
      // Tests read @bba/shared from source so they don't require a build step;
      // the package's own `main` points at dist, which is what production uses.
      "@bba/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    name: "@bba/api",
    globals: false,
    include: ["src/**/*.test.ts"],
    // Prisma + a real Postgres: keep DB-touching suites off each other's toes.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
