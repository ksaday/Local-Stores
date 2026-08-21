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

/** Bounds the keyboard walk on a long page — a catalog can run to hundreds. */
const MAX_TAB_STOPS = 60;

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

      // The skip link is layout-wide, so it is proved once rather than on all
      // eighteen pages. The storefront is a fair sample: public, and the first
      // page most people meet.
      const first = results.length === 0;
      const skip = first ? await skipLinkAudit(page) : null;
      const keyboard = await keyboardAudit(page);
      // Once per run, on the first page, and last — it strips the page's
      // styling to do its work, so nothing else may read the page afterwards.
      const selfTest = first ? await probeSelfTest(page) : null;

      results.push({ path, label, violations: run.violations, keyboard, skip, selfTest });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  report(results);
}

/**
 * The half of NFR-A11Y-02 that axe cannot see: can somebody drive this page
 * with a keyboard, and can they tell where they are while doing it.
 *
 * axe checks that a control has a name and a role. It does not check that the
 * control is reachable by Tab, or that anything on screen changes when it is —
 * and a focus ring that has been styled away leaves a keyboard user typing
 * blind into a page that looks inert.
 *
 * A real Tab press first, because `:focus-visible` keys off how the focus
 * arrived: focus moved by script does not necessarily match it, so a probe
 * that only called `.focus()` would report every element as unstyled and be
 * ignored within a day.
 */
async function keyboardAudit(page) {
  await page.keyboard.press("Tab");

  return page.evaluate((max) => {
    const issues = [];
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

    const visible = [...document.querySelectorAll(selector)].filter((el) => {
      if (el.disabled) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      // Off-screen by design — the skip link lives here until it is focused,
      // and checking its resting position would fail it for working correctly.
      const box = el.getBoundingClientRect();
      return box.width > 0 || box.height > 0 || el.className.includes("sr-only");
    });

    /**
     * Whether a ring is actually drawn, rather than merely declared.
     *
     * Not a string comparison of box-shadow: `ring-0` still emits a shadow —
     * `rgba(0,0,0,0) 0px 0px 0px 0px` — which differs from `none` as text while
     * being invisible on screen. A probe that compared strings would pass a
     * focus style somebody had set to zero width, which is the regression it
     * most needs to catch.
     */
    const paints = (value) =>
      value !== "none" && /(?:^|\s)(?!0px)(\d*\.?\d+)px/.test(value) && !/^rgba\(0, 0, 0, 0\)/.test(value);

    const measure = (el) => {
      const s = getComputedStyle(el);
      return {
        outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0,
        shadow: paints(s.boxShadow),
        // A control may signal focus by changing colour instead of adding a
        // ring, which is just as visible and equally acceptable.
        paint: `${s.backgroundColor}|${s.borderColor}|${s.color}`,
      };
    };

    for (const el of visible.slice(0, max)) {
      // Blur first. The Tab press that put the browser into keyboard mode also
      // left focus on the first control, so measuring its "resting" style
      // without this reads it while it is already lit — and then reports the
      // one element with a working focus style as the one without.
      el.blur();
      const resting = measure(el);
      el.focus();

      if (document.activeElement !== el) {
        issues.push({ kind: "not focusable", html: el.outerHTML.slice(0, 120) });
        continue;
      }

      const focused = measure(el);
      const visibleChange =
        (focused.outline && !resting.outline) ||
        (focused.shadow && !resting.shadow) ||
        focused.paint !== resting.paint;

      if (!visibleChange) {
        issues.push({ kind: "no visible focus", html: el.outerHTML.slice(0, 120) });
      }
      el.blur();
    }

    return { checked: Math.min(visible.length, max), issues };
  }, MAX_TAB_STOPS);
}

/**
 * Proves the focus probe can still fail, before its clean result is believed.
 *
 * Every attempt to verify this by hand — setting the ring to zero width,
 * overriding the rule in the stylesheet — produced a *pass*, because the
 * browser quietly substitutes its own focus ring the moment the author's one
 * stops applying. A check that cannot be made to fail is not a check, and this
 * one had to be pointed at a page with the indicator genuinely gone to know
 * the difference.
 *
 * So the gate carries its own canary: focus styling is stripped for real, the
 * probe is run, and finding nothing is itself the failure.
 */
async function probeSelfTest(page) {
  // Only the indicator is removed. An earlier version also reverted the
  // colours, which applies *on focus* and so invented the very change it was
  // supposed to be taking away — the canary passed itself.
  await page.addStyleTag({
    content: `*:focus, *:focus-visible {
      outline: none !important;
      box-shadow: none !important;
    }`,
  });

  const { issues, checked } = await keyboardAudit(page);
  await page.reload({ waitUntil: "domcontentloaded" });

  if (checked > 0 && issues.length === 0) {
    return [
      "the focus probe reported nothing on a page with focus styling stripped — " +
        "it cannot detect a missing focus ring, so its clean results mean nothing",
    ];
  }
  return [];
}

/**
 * The skip link is the first thing a keyboard user meets (NFR-A11Y-02), so it
 * is checked where it lives — in the shared layout — rather than once per page.
 */
async function skipLinkAudit(page) {
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const box = el.getBoundingClientRect();
    return {
      href: el.getAttribute("href"),
      text: (el.textContent || "").trim(),
      // It has to become visible on focus; one that stays off-screen is a link
      // only a screen reader knows about.
      onScreen: box.top >= 0 && box.left >= 0 && box.width > 0 && box.height > 0,
    };
  });

  if (!first) return ["skip-to-content — nothing is focusable, the first Tab went nowhere"];
  if (!first.href?.startsWith("#")) {
    return [`skip-to-content — the first tab stop is "${first.text}", not a skip link`];
  }
  if (!first.onScreen) return ["skip-to-content — the link stays off-screen when focused"];

  const target = await page.evaluate((h) => Boolean(document.querySelector(h)), first.href);
  return target ? [] : [`skip-to-content — points at ${first.href}, which is not on the page`];
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

  // The signed-in owner's own shop, not whichever store happens to sort first
  // in the public directory.
  //
  // Taking the first link meant any other store in the database could displace
  // the seeded one — a load-test fixture with no catalog did exactly that, and
  // the product page silently dropped out of the run. The page count barely
  // moved, so the only sign was a missing line in a list of eighteen.
  const storeResponse = await context.request.get(`${API}/api/v1/stores/${storeId}`);
  const store = storeResponse.ok() ? await storeResponse.json().catch(() => null) : null;
  const slug = store?.data?.slug;
  if (!slug) throw new Error(`Could not read the slug for store ${storeId}.`);

  await page.goto(`${BASE}/stores/${slug}`, { waitUntil: "domcontentloaded" });
  const productPath = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href*="/products/"]')][0];
    return a ? new URL(a.href).pathname : null;
  });
  if (!productPath) {
    throw new Error(
      `${slug} has no product to audit. Run the dev seed — a silently shorter ` +
        `run is the failure this check exists to prevent.`,
    );
  }

  await context.close();

  const pages = [
    { path: "/", label: "home" },
    { path: "/stores", label: "store directory" },
    { path: "/signin", label: "sign in" },
    { path: "/signup", label: "sign up" },
    { path: "/forgot-password", label: "forgot password" },
  ];

  pages.push(
    { path: `/stores/${slug}`, label: "storefront" },
    { path: `/stores/${slug}/cart`, label: "cart" },
    { path: productPath, label: "product" },
  );

  // The ops surfaces. NFR-A11Y-01 holds them to AA for perception and
  // operation, which is what axe measures, so they are in the gate too.
  {
    for (const [seg, label] of [
      ["", "ops overview"],
      ["orders", "order queue"],
      ["catalog", "catalog"],
      ["inventory", "stock"],
      ["deliveries", "deliveries"],
      ["customers", "customers"],
      ["reports", "reports"],
      ["till", "till"],
      ["staff", "staff"],
      ["coupons", "coupons"],
      ["settings", "store settings"],
    ]) {
      const path = seg ? `/store/${storeId}/ops/${seg}` : `/store/${storeId}/ops`;
      pages.push({ path, label, needsAuth: true });
    }
    pages.push({ path: "/account", label: "account", needsAuth: true });
    pages.push({ path: "/notifications", label: "notifications", needsAuth: true });
  }

  return pages;
}


function report(results) {
  let failures = 0;

  for (const r of results) {
    if (r.error) {
      failures += 1;
      console.log(`✗ ${r.label} (${r.path}) — could not audit: ${r.error}`);
      continue;
    }
    const kb = r.keyboard?.issues ?? [];
    const skip = [...(r.skip ?? []), ...(r.selfTest ?? [])];

    if (r.violations.length === 0 && kb.length === 0 && skip.length === 0) {
      console.log(`✓ ${r.label} (${r.path})  ·  ${r.keyboard?.checked ?? 0} tab stops`);
      continue;
    }

    failures += r.violations.length + kb.length + skip.length;
    console.log(`✗ ${r.label} (${r.path})`);

    for (const problem of skip) console.log(`    ${problem}`);
    for (const issue of kb) {
      console.log(`    keyboard — ${issue.kind}`);
      console.log(`      ${issue.html.replace(/\s+/g, " ")}`);
    }
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
