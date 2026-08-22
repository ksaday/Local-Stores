#!/usr/bin/env node
// Bundle budget (plan §15 Phase 11: "bundle analysis").
//
// The app is lean today — a ~100KB shared baseline that is almost entirely
// React and Next, and no route more than about 10KB over it. That is a
// property worth keeping, and it is the kind that erodes one import at a time:
// a date library here, a charting library there, each defensible on its own
// and none of them noticed until a shop on a phone at the kerb waits ten
// seconds for the delivery screen.
//
// So this measures rather than trusts. It fails the build when the shared
// baseline or any single route crosses its ceiling.
//
//   npm run bundle          after a web build
//
// The numbers are gzipped bytes of the JavaScript a route loads before it can
// be interactive, computed from Next's own build manifest. They run about
// 2-3KB under the figures `next build` prints, which include a little inline
// bootstrap this cannot see; the difference is constant and does not matter to
// a ceiling.

import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const NEXT_DIR = "apps/web/.next";

/**
 * Ceilings, in gzipped kilobytes.
 *
 * Set with room for ordinary growth and none for a new framework: the shared
 * baseline is ~100 and a route is at most ~110, so a single charting or date
 * library would breach both. They are meant to be raised deliberately, in a
 * commit that says why — not nudged whenever they go red.
 */
const BUDGET = { shared: 115, route: 135 };

const appManifest = require(`../${NEXT_DIR}/app-build-manifest.json`);

const gzipped = (file) => gzipSync(readFileSync(`${NEXT_DIR}/${file}`)).length;
const kb = (bytes) => bytes / 1024;
const show = (bytes) => `${kb(bytes).toFixed(1)} kB`;

/**
 * The chunks every route loads.
 *
 * Whatever appears in all of them: that is the shared baseline, and it is what
 * a single stray top-level import would inflate for the whole app at once.
 */
const routes = Object.entries(appManifest.pages).filter(([name]) => name.endsWith("/page"));
if (routes.length === 0) {
  console.error(`No routes in ${NEXT_DIR}/app-build-manifest.json. Run the web build first.`);
  process.exit(1);
}

const shared = routes
  .map(([, files]) => new Set(files))
  .reduce((common, files) => new Set([...common].filter((f) => files.has(f))));

const sharedBytes = [...shared].reduce((total, f) => total + gzipped(f), 0);

const measured = routes
  .map(([name, files]) => ({
    name: name.replace(/\/page$/, "") || "/",
    bytes: [...new Set(files)].reduce((total, f) => total + gzipped(f), 0),
  }))
  .sort((a, b) => b.bytes - a.bytes);

console.log(`Shared by every route: ${show(sharedBytes)}  (budget ${BUDGET.shared} kB)`);
console.log(`Heaviest routes, first-load JavaScript (budget ${BUDGET.route} kB):\n`);
for (const r of measured.slice(0, 8)) {
  const over = kb(r.bytes) > BUDGET.route;
  console.log(`  ${over ? "✗" : "✓"} ${show(r.bytes).padStart(9)}  ${r.name}`);
}

const failures = [];
if (kb(sharedBytes) > BUDGET.shared) {
  failures.push(
    `The shared baseline is ${show(sharedBytes)}, over the ${BUDGET.shared} kB budget. ` +
      `Something every route loads has grown — usually a top-level import in a layout ` +
      `or a component that lost its "use client" boundary.`,
  );
}
for (const r of measured.filter((r) => kb(r.bytes) > BUDGET.route)) {
  failures.push(`${r.name} loads ${show(r.bytes)}, over the ${BUDGET.route} kB budget.`);
}

if (failures.length > 0) {
  console.error("");
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    `\nRaise a budget only in a commit that explains what was added and why it is worth it.`,
  );
  process.exit(1);
}

console.log(`\n${measured.length} routes, all inside budget.`);
