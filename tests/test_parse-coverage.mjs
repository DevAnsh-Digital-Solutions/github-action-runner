#!/usr/bin/env node
// tests/test_parse-coverage.mjs
//
// Unit tests for scripts/parse-coverage.mjs. Run directly:
//   node tests/test_parse-coverage.mjs
// No test framework dependency — plain assertions, since this repo has no
// application code and shouldn't need a devDependency tree just to test
// its own helper scripts.

import assert from 'node:assert/strict';
import {
  parseLcov,
  parseJsonSummary,
  parseCoverageText,
  buildResult,
} from '../scripts/parse-coverage.mjs';

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL: ${name}`);
    console.log(`  ${err.message}`);
  }
}

const LCOV_SAMPLE = `SF:src/a.ts
FNF:2
FNH:2
BRF:4
BRH:2
LF:10
LH:8
end_of_record
SF:src/b.ts
FNF:1
FNH:0
BRF:2
BRH:0
LF:5
LH:2
end_of_record
`;

const JSON_SUMMARY_SAMPLE = {
  total: {
    lines: { total: 100, covered: 85, pct: 85 },
    statements: { total: 100, covered: 85, pct: 85 },
    functions: { total: 20, covered: 18, pct: 90 },
    branches: { total: 40, covered: 30, pct: 75 },
  },
};

test('parseLcov sums LF/LH/BRF/BRH/FNF/FNH across multiple SF blocks', () => {
  const totals = parseLcov(LCOV_SAMPLE);
  assert.deepEqual(totals.lines, { covered: 10, total: 15 });
  assert.deepEqual(totals.branches, { covered: 2, total: 6 });
  assert.deepEqual(totals.functions, { covered: 2, total: 3 });
});

test('parseLcov throws on text with no LF/LH records', () => {
  assert.throws(() => parseLcov('not an lcov file\njust some text\n'), /no LF\/LH records/);
});

test('parseJsonSummary reads the aggregate "total" key', () => {
  const totals = parseJsonSummary(JSON_SUMMARY_SAMPLE);
  assert.deepEqual(totals.lines, { covered: 85, total: 100 });
  assert.deepEqual(totals.branches, { covered: 30, total: 40 });
  assert.deepEqual(totals.functions, { covered: 18, total: 20 });
});

test('parseJsonSummary throws when there is no "total" key', () => {
  assert.throws(() => parseJsonSummary({ 'src/a.ts': {} }), /no "total" key/);
});

test('parseCoverageText auto-detects json-summary', () => {
  const totals = parseCoverageText(JSON.stringify(JSON_SUMMARY_SAMPLE));
  assert.equal(totals.lines.covered, 85);
});

test('parseCoverageText auto-detects lcov', () => {
  const totals = parseCoverageText(LCOV_SAMPLE);
  assert.equal(totals.lines.covered, 10);
});

test('parseCoverageText throws a combined error when neither format matches', () => {
  assert.throws(() => parseCoverageText('{ this is neither valid json nor lcov'), /could not parse as/);
});

test('buildResult passes when lines pct is at or above threshold', () => {
  const result = buildResult({ lines: { covered: 8, total: 10 }, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } }, 80);
  assert.equal(result.lines.pct, 80);
  assert.equal(result.passed, true);
});

test('buildResult fails when lines pct is below threshold', () => {
  const result = buildResult({ lines: { covered: 7, total: 10 }, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } }, 80);
  assert.equal(result.lines.pct, 70);
  assert.equal(result.passed, false);
});

test('buildResult reports null pct (not 0%) for a metric with zero total', () => {
  const result = buildResult({ lines: { covered: 8, total: 10 }, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } }, 80);
  assert.equal(result.branches.pct, null);
  assert.equal(result.functions.pct, null);
});

test('buildResult throws when lines total is zero — never silently 0% or passing', () => {
  assert.throws(
    () => buildResult({ lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } }, 80),
    /zero total lines/,
  );
});

if (failures === 0) {
  console.log('All tests passed.');
  process.exit(0);
} else {
  console.log(`${failures} test(s) failed.`);
  process.exit(1);
}
