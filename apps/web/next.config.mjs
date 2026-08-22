import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Emits .next/standalone: a self-contained server with only the modules the
  // app actually reaches, traced from the entry points. The alternative is
  // shipping the whole workspace's node_modules into the image, which for this
  // repo means a Prisma client and an OpenTelemetry SDK the web app never
  // loads.
  output: "standalone",

  // Tracing starts at the monorepo root, not at apps/web. npm hoists most
  // dependencies to the root node_modules, so without this Next traces from
  // apps/web, finds almost nothing there, and produces a standalone build that
  // is missing its own dependencies at runtime — a failure that only appears
  // when the container starts.
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "../.."),
  // packages/shared is TypeScript source in dev; Next compiles it with the app.
  transpilePackages: ["@bba/shared"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default nextConfig;
