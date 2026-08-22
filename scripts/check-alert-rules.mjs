#!/usr/bin/env node
/**
 * Checks that the alert rules describe a system that exists.
 *
 * An alerting rule is the one piece of production configuration that gives no
 * feedback when it is wrong. A rule naming `checkout_completions` when the
 * metric is `checkout_completions_total` is valid PromQL, loads without
 * complaint, evaluates forever against an empty vector, and never fires. The
 * failure is silence, and it is indistinguishable from everything being fine —
 * which is exactly the failure the alert existed to prevent.
 *
 * So this gate reads the rules and the source together and fails CI when they
 * disagree:
 *
 *   1. Every metric an expression names is registered somewhere in the API.
 *   2. Every `runbook:` annotation points at a heading that exists.
 *   3. Every alert carries a severity, a summary and a runbook link.
 *
 * The second matters as much as the first. A page at 3am whose runbook link
 * lands on a missing anchor is a dead end at the worst possible moment.
 *
 * One known limit: metrics from `collectDefaultMetrics` are not registered in
 * our source, so they are accepted on their `process_` / `nodejs_` prefix alone
 * and a typo in the rest of the name would pass. There are two such rules, and
 * both were checked against a live scrape by hand.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const RULES = "infra/monitoring/alerts.yml";
const RUNBOOKS = "docs/ops/runbooks.md";
const API_SRC = "apps/api/src";

/**
 * PromQL's own vocabulary, which shares a namespace with metric names.
 *
 * Anything here is dropped before the remaining identifiers are treated as
 * metrics. Missing an entry produces a false failure rather than a false pass,
 * which is the right way round for a gate.
 */
const PROMQL_KEYWORDS = new Set([
  "sum", "min", "max", "avg", "count", "stddev", "stdvar", "topk", "bottomk", "quantile",
  "rate", "irate", "increase", "delta", "idelta", "deriv", "predict_linear", "resets", "changes",
  "histogram_quantile", "clamp", "clamp_min", "clamp_max", "abs", "ceil", "floor", "round",
  "exp", "ln", "log2", "log10", "sqrt", "sgn",
  "absent", "absent_over_time", "present_over_time", "vector", "scalar", "time", "timestamp",
  "label_replace", "label_join", "sort", "sort_desc", "group",
  "avg_over_time", "sum_over_time", "min_over_time", "max_over_time", "count_over_time",
  "last_over_time", "quantile_over_time", "stddev_over_time",
  "by", "without", "on", "ignoring", "group_left", "group_right", "offset", "bool", "and", "or", "unless",
  "le", "inf", "nan",
]);

/** Suffixes Prometheus derives from a histogram's base name. */
const HISTOGRAM_SUFFIXES = ["_bucket", "_sum", "_count"];

/** Families `collectDefaultMetrics` registers, which are not in our source. */
const DEFAULT_METRIC_PREFIXES = ["process_", "nodejs_"];

function fail(messages) {
  console.error("\nAlert rules do not match the system:\n");
  for (const m of messages) console.error(`  ✗ ${m}`);
  console.error("");
  process.exit(1);
}

/** Every .ts file under the API source. */
function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * Metric names the API actually registers.
 *
 * Read from the `new Counter/Gauge/Histogram({ ... name: "..." })` calls rather
 * than from a running process, so the check needs no database, no Redis and no
 * server — a gate that only works when the stack is up is a gate that gets
 * skipped.
 */
function registeredMetrics() {
  const names = new Set();
  const constructor = /new\s+(?:Counter|Gauge|Histogram|Summary)\s*\(\s*\{([\s\S]*?)\}\s*\)/g;

  for (const file of sourceFiles(API_SRC)) {
    const source = readFileSync(file, "utf8");
    for (const [, body] of source.matchAll(constructor)) {
      const name = /name:\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]/.exec(body);
      if (name) names.add(name[1]);
    }
  }
  return names;
}

/** Metric names an expression refers to. */
function metricsIn(expr) {
  const stripped = expr
    // Label matchers: `{cause!="confirm_failed"}` — the identifiers inside are
    // label names, not metrics.
    .replace(/\{[^}]*\}/g, "")
    // Range and offset selectors: `[10m]` would otherwise leave a bare `m`,
    // which reads like a metric name nothing registers.
    .replace(/\[[^\]]*\]/g, "")
    // Grouping clauses: `by (le, operation)`.
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/'[^']*'/g, "");

  const found = new Set();
  for (const [identifier] of stripped.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)) {
    if (PROMQL_KEYWORDS.has(identifier)) continue;
    found.add(identifier);
  }
  return found;
}

/** True when `metric` is registered, allowing for derived histogram series. */
function isKnown(metric, registered) {
  if (registered.has(metric)) return true;
  if (DEFAULT_METRIC_PREFIXES.some((p) => metric.startsWith(p))) return true;

  return HISTOGRAM_SUFFIXES.some(
    (suffix) => metric.endsWith(suffix) && registered.has(metric.slice(0, -suffix.length)),
  );
}

/** GitHub-style anchors for every heading in the runbooks. */
function runbookAnchors() {
  const anchors = new Set();
  for (const line of readFileSync(RUNBOOKS, "utf8").split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;

    const anchor = heading[1]
      .trim()
      .toLowerCase()
      .replace(/`/g, "")
      .replace(/[^\w\s-]/g, "")
      .replace(/\s/g, "-");
    anchors.add(anchor);
  }
  return anchors;
}

const rules = parse(readFileSync(RULES, "utf8"));
const registered = registeredMetrics();
const anchors = runbookAnchors();
const problems = [];

let alertCount = 0;
const bySeverity = {};

for (const group of rules.groups ?? []) {
  for (const rule of group.rules ?? []) {
    if (!rule.alert) continue;
    alertCount += 1;

    const severity = rule.labels?.severity;
    if (!severity) problems.push(`${rule.alert}: no severity label — nothing knows where to route it`);
    else bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;

    if (!rule.annotations?.summary) problems.push(`${rule.alert}: no summary annotation`);

    const runbook = rule.annotations?.runbook;
    if (!runbook) {
      problems.push(`${rule.alert}: no runbook link — a page with nowhere to go`);
    } else {
      const anchor = runbook.split("#")[1];
      if (!anchor) problems.push(`${rule.alert}: runbook link has no anchor (${runbook})`);
      else if (!anchors.has(anchor)) {
        problems.push(`${rule.alert}: runbook anchor "#${anchor}" is not a heading in ${RUNBOOKS}`);
      }
    }

    for (const metric of metricsIn(rule.expr ?? "")) {
      if (!isKnown(metric, registered)) {
        problems.push(`${rule.alert}: refers to "${metric}", which nothing registers — it can never fire`);
      }
    }
  }
}

if (problems.length > 0) fail(problems);

const severities = Object.entries(bySeverity)
  .map(([name, n]) => `${n} ${name}`)
  .join(", ");
console.log(`Alert rules: ${alertCount} alerts (${severities}).`);
console.log(`Every metric is registered and every runbook link resolves.`);
