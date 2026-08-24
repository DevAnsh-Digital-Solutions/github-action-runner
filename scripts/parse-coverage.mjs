#!/usr/bin/env node
// scripts/parse-coverage.mjs
//
// Parses an lcov (lcov.info) or Istanbul json-summary (coverage-summary.json)
// coverage report into normalized lines/branches/functions percentages,
// compares the "lines" percentage against a threshold, and prints a single
// JSON line with the result. Used by .github/actions/coverage/action.yml,
// and unit-tested directly in tests/test_parse-coverage.mjs — composite
// action shell steps aren't unit-testable on their own, so the actual
// parsing/comparison logic lives here instead.
//
// Usage: node parse-coverage.mjs <coverage-file> <threshold>
// Prints: {"lines":{...},"branches":{...},"functions":{...},"threshold":N,"passed":bool}
// Exits 0 once the file is successfully parsed, REGARDLESS of "passed" —
// the caller decides what to do with a failing threshold. Exits 1 (with a
// message on stderr) if the file can't be read, isn't recognizable as
// either format, or reports zero total lines (which can't be meaningfully
// compared to a threshold and usually means instrumentation didn't run).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// parseLcov(text) -> { lines, branches, functions } each as {covered, total}
// lcov.info can contain one record block per source file (SF:...); totals
// are summed across every block since we only need project-wide percentages.
export function parseLcov(text) {
  const totals = {
    lines: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
  };
  let sawRecord = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const [key, value] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)];
    switch (key) {
      case 'LF': totals.lines.total += Number(value); sawRecord = true; break;
      case 'LH': totals.lines.covered += Number(value); break;
      case 'BRF': totals.branches.total += Number(value); break;
      case 'BRH': totals.branches.covered += Number(value); break;
      case 'FNF': totals.functions.total += Number(value); break;
      case 'FNH': totals.functions.covered += Number(value); break;
      default: break;
    }
  }
  if (!sawRecord) {
    throw new Error('no LF/LH records found — this does not look like an lcov report');
  }
  return totals;
}

// parseJsonSummary(json) -> same shape, read from Istanbul's aggregate "total" key.
export function parseJsonSummary(json) {
  if (!json || typeof json !== 'object' || !json.total) {
    throw new Error('no "total" key found — this does not look like an Istanbul json-summary report');
  }
  const pick = (metric) => ({
    covered: Number(json.total[metric]?.covered ?? 0),
    total: Number(json.total[metric]?.total ?? 0),
  });
  return {
    lines: pick('lines'),
    branches: pick('branches'),
    functions: pick('functions'),
  };
}

// parseCoverageText(text) -> normalized totals, trying json-summary first
// (a clean JSON.parse is an unambiguous signal) and falling back to lcov.
export function parseCoverageText(text) {
  try {
    const json = JSON.parse(text);
    return parseJsonSummary(json);
  } catch (jsonError) {
    try {
      return parseLcov(text);
    } catch (lcovError) {
      throw new Error(
        `could not parse as Istanbul json-summary (${jsonError.message}) or lcov (${lcovError.message})`,
      );
    }
  }
}

// pct(metric) -> covered/total as a percentage rounded to 2 decimals, or
// null if total is 0 (undefined coverage, not 0% — the caller must treat
// this as a data-quality problem, never as a passing or failing score).
function pct(metric) {
  if (metric.total === 0) return null;
  return Math.round((metric.covered / metric.total) * 10000) / 100;
}

// buildResult(totals, threshold) -> the full JSON payload this script prints.
// Gates pass/fail on the "lines" percentage — the single scalar threshold
// input only supports one gating metric, and "lines" is the conventional
// headline coverage number. Branches/functions are still reported for
// visibility in the summary table, just not gated on.
export function buildResult(totals, threshold) {
  const linesPct = pct(totals.lines);
  if (linesPct === null) {
    throw new Error('coverage report has zero total lines — instrumentation likely did not run');
  }
  return {
    lines: { ...totals.lines, pct: linesPct },
    branches: { ...totals.branches, pct: pct(totals.branches) },
    functions: { ...totals.functions, pct: pct(totals.functions) },
    threshold,
    passed: linesPct >= threshold,
  };
}

function main() {
  const [, , filePath, thresholdArg] = process.argv;
  if (!filePath || thresholdArg === undefined) {
    console.error('usage: node parse-coverage.mjs <coverage-file> <threshold>');
    process.exit(1);
  }
  const threshold = Number(thresholdArg);
  if (!Number.isFinite(threshold)) {
    console.error(`threshold must be a number, got '${thresholdArg}'`);
    process.exit(1);
  }

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`could not read coverage file '${filePath}': ${err.message}`);
    process.exit(1);
  }

  try {
    const totals = parseCoverageText(text);
    const result = buildResult(totals, threshold);
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    console.error(`could not parse coverage file '${filePath}': ${err.message}`);
    process.exit(1);
  }
}

// A plain string comparison against `file://${process.argv[1]}` breaks on
// Windows (backslashes, drive-letter casing) — pathToFileURL normalizes both
// sides the same way regardless of platform.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
