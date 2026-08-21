#!/usr/bin/env node
// Accessibility gate (NFR-A11Y-04): axe over the key pages, in a real browser.
//
// A real browser and not jsdom, because half of WCAG AA is about what a person
// actually sees — contrast, focus order, whether a control is visible at all —
// and none of that exists without layout and computed styles. A jsdom sweep
// would pass while the storefront was unreadable.
//
// Pages are discovered rather than hard-coded: the seed's slugs and ids change,
// and a list of stale URLs is a suite that silently audits 404s. The only fixed
// paths are the ones that are fixed in the router.
//
//   npm run a11y                 against an already-running stack
//   npm run a11y -- --base=…     against somewhere else
//
// Exits non-zero on any violation, printing the rule, the impact, and the
// element — enough to fix it without opening a browser.

import { chromium } from "playwright";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);

const BASE = args.get("base") ?? "http://localhost:3100";
// The BFF forwards only the handful of auth actions that set cookies, and
// `me` is not one of them — it is a GET the app makes server-side. Asking the
// API for it directly works because the session cookie is host-only and
// cookies ignore ports, so the jar from signing in above is already valid here.
const API = args.get("api") ?? "http://localhost:3001";
const OWNER_EMAIL = args.get("email") ?? "owner@morseavebakery.test";
const OWNER_PASSWORD = args.get("password") ?? "bakery-dev-password-1";

/**
 * WCAG 2.2 AA, which is the target in NFR-A11Y-01.
 *
 * `best-practice` is deliberately excluded: it is advice, not the standard, and
 * a gate that fails on advice gets switched off within a month.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * No rule exclusions.
 *
 * There is deliberately no allowlist here: everything the standard asks for is
 * either met or is a bug to fix. An exclusion list is where a gate goes to die,
 * because the cheapest response to a red build is always to add one more line
 * to it.
 */

/** Time given to hydration after load before axe looks at the DOM. */
const SETTLE_MS = 1200;

async function main() {
  const browser = await chromium.launch();
  const results = [];

  try {
    const pages = await discoverPages(browser);
    console.log(`Auditing ${pages.length} pages at ${BASE}\n`);

    for (const { path, needsAuth, label } of pages) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      if (needsAuth) await signIn(context);

      const page = await context.newPage();
      // Not `networkidle`: the ops screens hold an SSE stream open for live
      // order updates, so the network is never idle and the wait can only ever
      // time out. Wait for the document, then give hydration a moment — axe
      // needs the DOM React actually produced, not the server's first pass.
      const response = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("load").catch(() => {});
      await page.waitForTimeout(SETTLE_MS);

      // A redirected or missing page audits clean and proves nothing, so it is
      // a failure of the gate rather than a pass.
      const landed = new URL(page.url()).pathname;
      if (!response || response.status() >= 400) {
        results.push({ path, label, error: `HTTP ${response?.status() ?? "no response"}` });
        await context.close();
        continue;
      }
      if (landed !== path) {
        results.push({ path, label, error: `redirected to ${landed}` });
        await context.close();
        continue;
      }

      await page.addScriptTag({ path: AXE_PATH });
      const run = await page.evaluate(
        ([tags]) => window.axe.run(document, { runOnly: { type: "tag", values: tags } }),
        [TAGS],
      );

      results.push({ path, label, violations: run.violations });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  report(results);
}

/**
 * Signs in through the app's own BFF, so the cookies are exactly the ones a
 * person would have. Hitting the API directly would set them on the wrong
 * origin and every ops page would bounce to the sign-in screen.
 */
async function signIn(context) {
  const response = await context.request.post(`${BASE}/api/auth/login`, {
    data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  if (!response.ok()) {
    throw new Error(
      `Could not sign in as ${OWNER_EMAIL} (${response.status()}). Has the dev seed been run?`,
    );
  }
}

/** Finds a real store, product and store id from the running app. */
async function discoverPages(browser) {
  const context = await browser.newContext();
  await signIn(context);
  const page = await context.newPage();

  // Wrapped, because a connection failure here throws an error whose message
  // is a dump of the request — including the `cookie` header, and therefore a
  // live session token. CI logs outlive the session and are read by more people
  // than the app is.
  let me = null;
  try {
    const meResponse = await context.request.get(`${API}/api/v1/auth/me`);
    if (meResponse.ok()) me = await meResponse.json().catch(() => null);
  } catch {
    throw new Error(`Could not reach the API at ${API} to look up the signed-in store.`);
  }
  const storeId = me?.data?.memberships?.[0]?.storeId;

  // Loudly, not silently. Skipping the ops pages because a lookup quietly
  // returned undefined is how a gate ends up auditing five public pages and
  // reporting that everything is fine.
  if (!storeId) {
    throw new Error(
      `Signed in as ${OWNER_EMAIL} but found no store membership at ${API}. ` +
        `The ops pages would be skipped, so this is a failure rather than a short run.`,
    );
  }

  await page.goto(`${BASE}/stores`, { waitUntil: "domcontentloaded" });
  const slug = await firstSegment(page, "/stores/");

  let productPath = null;
  if (slug) {
    await page.goto(`${BASE}/stores/${slug}`, { waitUntil: "domcontentloaded" });
    productPath = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a[href*="/products/"]')][0];
      return a ? new URL(a.href).pathname : null;
    });
  }

  await context.close();

  const pages = [
    { path: "/", label: "home" },
    { path: "/stores", label: "store directory" },
    { path: "/signin", label: "sign in" },
    { path: "/signup", label: "sign up" },
    { path: "/forgot-password", label: "forgot password" },
  ];

  if (slug) {
    pages.push(
      { path: `/stores/${slug}`, label: "storefront" },
      { path: `/stores/${slug}/cart`, label: "cart" },
    );
  }
  if (productPath) pages.push({ path: productPath, label: "product" });

  // The ops surfaces. NFR-A11Y-01 holds them to AA for perception and
  // operation, which is what axe measures, so they are in the gate too.
  {
    for (const [seg, label] of [
      ["orders", "order queue"],
      ["catalog", "catalog"],
      ["inventory", "stock"],
      ["deliveries", "deliveries"],
      ["till", "till"],
      ["staff", "staff"],
      ["coupons", "coupons"],
      ["settings", "store settings"],
    ]) {
      pages.push({ path: `/store/${storeId}/ops/${seg}`, label, needsAuth: true });
    }
    pages.push({ path: "/account", label: "account", needsAuth: true });
    pages.push({ path: "/notifications", label: "notifications", needsAuth: true });
  }

  return pages;
}

async function firstSegment(page, prefix) {
  return page.evaluate((p) => {
    const a = [...document.querySelectorAll(`a[href*="${p}"]`)][0];
    if (!a) return null;
    const rest = new URL(a.href).pathname.slice(p.length);
    return rest.split("/")[0] || null;
  }, prefix);
}

function report(results) {
  let failures = 0;

  for (const r of results) {
    if (r.error) {
      failures += 1;
      console.log(`✗ ${r.label} (${r.path}) — could not audit: ${r.error}`);
      continue;
    }
    if (r.violations.length === 0) {
      console.log(`✓ ${r.label} (${r.path})`);
      continue;
    }

    failures += r.violations.length;
    console.log(`✗ ${r.label} (${r.path})`);
    for (const v of r.violations) {
      console.log(`    ${v.id} [${v.impact}] — ${v.help}`);
      console.log(`    ${v.helpUrl}`);
      for (const node of v.nodes.slice(0, 3)) {
        console.log(`      ${node.html.replace(/\s+/g, " ").slice(0, 140)}`);
      }
      if (v.nodes.length > 3) console.log(`      …and ${v.nodes.length - 3} more`);
    }
  }

  const audited = results.filter((r) => !r.error).length;
  console.log(
    failures === 0
      ? `\nNo WCAG 2.2 AA violations across ${audited} pages.`
      : `\n${failures} problem(s) across ${results.length} pages.`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  // Only ever the message, and only its first line. Playwright puts the failing
  // request's headers into some of these, and `cookie` is one of them.
  const message = err instanceof Error ? err.message : String(err);
  console.error(message.split("\n")[0]);
  process.exit(1);
});
