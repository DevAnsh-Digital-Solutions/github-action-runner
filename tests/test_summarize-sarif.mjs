#!/usr/bin/env node
// tests/test_summarize-sarif.mjs
//
// Unit tests for scripts/summarize-sarif.mjs. Run directly:
//   node tests/test_summarize-sarif.mjs

import assert from 'node:assert/strict';
import {
  extractResults,
  escapeData,
  escapeProperty,
  sarifLevelToCommand,
  formatMarkdownTable,
  formatAnnotations,
} from '../scripts/summarize-sarif.mjs';

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

const sampleSarif = {
  version: '2.1.0',
  runs: [
    {
      tool: { driver: { name: 'ESLint' } },
      results: [
        {
          ruleId: 'no-unused-vars',
          level: 'error',
          message: { text: 'x is defined but never used' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/foo.js' }, region: { startLine: 12 } } }],
        },
        {
          ruleId: 'no-console',
          message: { text: 'Unexpected console statement' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/bar.js' }, region: { startLine: 3 } } }],
        },
      ],
    },
  ],
};

test('extractResults flattens results across runs', () => {
  const results = extractResults(sampleSarif);
  assert.equal(results.length, 2);
  assert.equal(results[0].ruleId, 'no-unused-vars');
  assert.equal(results[0].level, 'error');
  assert.equal(results[0].file, 'src/foo.js');
  assert.equal(results[0].line, 12);
});

test('extractResults defaults a missing level to warning, per the SARIF spec', () => {
  const results = extractResults(sampleSarif);
  assert.equal(results[1].level, 'warning');
});

test('extractResults treats a missing "results" key on a run as zero findings', () => {
  assert.deepEqual(extractResults({ runs: [{}] }), []);
});

test('extractResults falls back to placeholders when ruleId/message/location are absent', () => {
  const results = extractResults({ runs: [{ results: [{}] }] });
  assert.equal(results[0].ruleId, 'unknown-rule');
  assert.equal(results[0].message, '(no message)');
  assert.equal(results[0].file, '(unknown file)');
  assert.equal(results[0].line, null);
});

test('extractResults throws on non-object input', () => {
  assert.throws(() => extractResults([1, 2, 3]), /expected a JSON object/);
  assert.throws(() => extractResults(null), /expected a JSON object/);
});

test('extractResults throws when "runs" is missing or not an array', () => {
  assert.throws(() => extractResults({}), /"runs" is missing/);
  assert.throws(() => extractResults({ runs: 'nope' }), /"runs" is missing/);
});

test('escapeData escapes %, CR, and LF for a workflow command body', () => {
  assert.equal(escapeData('100% done\r\nnext line'), '100%25 done%0D%0Anext line');
});

test('escapeProperty additionally escapes commas and colons', () => {
  assert.equal(escapeProperty('src/foo.js:12,bar'), 'src/foo.js%3A12%2Cbar');
});

test('sarifLevelToCommand maps SARIF levels to workflow commands', () => {
  assert.equal(sarifLevelToCommand('error'), 'error');
  assert.equal(sarifLevelToCommand('warning'), 'warning');
  assert.equal(sarifLevelToCommand('note'), 'notice');
  assert.equal(sarifLevelToCommand('none'), 'notice');
  assert.equal(sarifLevelToCommand('something-unrecognized'), 'warning');
});

test('formatMarkdownTable reports "No findings." for an empty result set', () => {
  assert.equal(formatMarkdownTable([]), 'No findings.');
});

test('formatMarkdownTable renders one row per finding with level/rule/location/message', () => {
  const table = formatMarkdownTable(extractResults(sampleSarif));
  assert.match(table, /\| error \| no-unused-vars \| src\/foo\.js:12 \| x is defined but never used \|/);
  assert.match(table, /\| warning \| no-console \| src\/bar\.js:3 \| Unexpected console statement \|/);
});

test('formatMarkdownTable escapes pipes and collapses newlines in messages so rows stay well-formed', () => {
  const results = [{ ruleId: 'r', level: 'error', message: 'a | b\nc', file: 'f.js', line: 1 }];
  const table = formatMarkdownTable(results);
  assert.match(table, /a \\\| b c/);
});

test('formatMarkdownTable truncates past maxRows and notes the remainder', () => {
  const results = Array.from({ length: 5 }, (_, i) => ({
    ruleId: `r${i}`,
    level: 'error',
    message: 'm',
    file: 'f.js',
    line: i,
  }));
  const table = formatMarkdownTable(results, { maxRows: 2 });
  assert.match(table, /3 more finding\(s\) not shown/);
  assert.equal((table.match(/\| error \|/g) ?? []).length, 2);
});

test('formatAnnotations emits one ::command:: line per finding with file/line/title', () => {
  const lines = formatAnnotations(extractResults(sampleSarif));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '::error file=src/foo.js,title=no-unused-vars,line=12::x is defined but never used');
  assert.equal(lines[1], '::warning file=src/bar.js,title=no-console,line=3::Unexpected console statement');
});

test('formatAnnotations omits the line property when no line number is known', () => {
  const results = [{ ruleId: 'r', level: 'error', message: 'm', file: 'f.js', line: null }];
  const lines = formatAnnotations(results);
  assert.equal(lines[0], '::error file=f.js,title=r::m');
});

test('formatAnnotations caps output at maxAnnotations', () => {
  const results = Array.from({ length: 20 }, (_, i) => ({
    ruleId: `r${i}`,
    level: 'error',
    message: 'm',
    file: 'f.js',
    line: i,
  }));
  assert.equal(formatAnnotations(results, { maxAnnotations: 5 }).length, 5);
});

test('formatAnnotations replaces the message with a generic pointer when includeMessage is false', () => {
  const results = [{ ruleId: 'gitleaks-generic-api-key', level: 'error', message: 'secret value XYZ', file: 'f.js', line: 1 }];
  const lines = formatAnnotations(results, { includeMessage: false });
  assert.doesNotMatch(lines[0], /secret value XYZ/);
  assert.match(lines[0], /see the uploaded SARIF artifact/);
});

if (failures === 0) {
  console.log('All tests passed.');
  process.exit(0);
} else {
  console.log(`${failures} test(s) failed.`);
  process.exit(1);
}
