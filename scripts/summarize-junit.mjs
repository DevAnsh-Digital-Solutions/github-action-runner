#!/usr/bin/env node
// scripts/summarize-junit.mjs
//
// Turns a JUnit XML results file (what `pytest --junitxml` writes) into (a)
// a markdown totals table plus a failing-tests table for $GITHUB_STEP_SUMMARY
// and (b) capped GitHub Actions annotation commands, so a failing Python test
// run gives a developer the failing test names and messages without opening
// the raw log. Used by .github/actions/unit-test/action.yml, and unit-tested
// directly in tests/test_summarize-junit.mjs.
//
// Usage:
//   node summarize-junit.mjs <junit-xml-file> table
//   node summarize-junit.mjs <junit-xml-file> annotations [maxAnnotations]
//
// "table" prints the same Total | Passed | Failed | Skipped table the JS test
// summary uses ("Failed" counts failures and errors together), followed by a
// Test | Message table of the failing tests when there are any. "annotations"
// prints one ::error workflow command per failing test, capped at
// maxAnnotations (default 15); the annotations carry a title but no file/line,
// since JUnit XML from pytest doesn't record the source location.
//
// Reads the XML with regular expressions rather than an XML parser: this repo
// deliberately has no dependency tree, and the subset needed here (testsuite
// count attributes, testcase/failure/error elements) is small and regular.
//
// Exits 0 once the file is successfully parsed, regardless of failures. Exits
// 1 (message on stderr) if the file can't be read or has no <testsuite>
// element.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// unescapeXml(text) -> text with the predefined XML entities and numeric
// character references decoded.
export function unescapeXml(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" decodes to "&lt;" and not "<"
}

// attrs(tag) -> {name: value} for the attributes of one XML start tag.
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    out[m[1]] = unescapeXml(m[2]);
  }
  return out;
}

// parseJunit(xmlText) -> {total, passed, failed, errors, skipped, failures:[{name, message}]}
// Totals are summed over every <testsuite> element. "failed" is failures +
// errors (a test that raised outside an assertion, or a collection error).
export function parseJunit(xmlText) {
  const suiteTags = xmlText.match(/<testsuite\b[^>]*>/g);
  if (!suiteTags) {
    throw new Error('no <testsuite> element found — this does not look like a JUnit XML report');
  }
  let total = 0;
  let failuresAttr = 0;
  let errors = 0;
  let skipped = 0;
  for (const tag of suiteTags) {
    const a = attrs(tag);
    total += Number(a.tests ?? 0);
    failuresAttr += Number(a.failures ?? 0);
    errors += Number(a.errors ?? 0);
    skipped += Number(a.skipped ?? 0);
  }

  const failures = [];
  // A failing testcase has a <failure>/<error> child; an empty-bodied passing
  // one is self-closing. Match both shapes, then look for a failure child.
  for (const m of xmlText.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[3];
    if (!body) continue;
    const problem = body.match(/<(failure|error)\b([^>]*)>/);
    if (!problem) continue;
    const tc = attrs(m[1]);
    const detail = attrs(problem[2]);
    const name = [tc.classname, tc.name].filter(Boolean).join('.') || '(unnamed test)';
    failures.push({ name, message: detail.message ?? `(${problem[1]} with no message)` });
  }

  const failed = failuresAttr + errors;
  return {
    total,
    passed: Math.max(total - failed - skipped, 0),
    failed,
    errors,
    skipped,
    failures,
  };
}

// firstLine(text) -> the first non-empty line, trimmed.
function firstLine(text) {
  return (String(text).split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
}

// mdCell(text) -> text safe inside a markdown table cell: a pipe would split
// the row, and a raw '<' in a test message could be swallowed as an HTML tag.
function mdCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/</g, '&lt;');
}

// formatTable(result, {maxRows}) -> markdown totals table, plus a failing-tests table.
export function formatTable(result, { maxRows = 50 } = {}) {
  const lines = [
    '| Total | Passed | Failed | Skipped |',
    '|---|---|---|---|',
    `| ${result.total} | ${result.passed} | ${result.failed} | ${result.skipped} |`,
  ];
  if (result.failures.length > 0) {
    lines.push('', '| Failing test | Message |', '|---|---|');
    for (const f of result.failures.slice(0, maxRows)) {
      lines.push(`| ${mdCell(f.name)} | ${mdCell(firstLine(f.message))} |`);
    }
    if (result.failures.length > maxRows) {
      lines.push('', `_${result.failures.length - maxRows} more failing test(s) not shown — see the test step's log._`);
    }
  }
  return lines.join('\n');
}

// escapeData / escapeProperty: GitHub workflow-command escaping (same rules
// as summarize-sarif.mjs; duplicated because each script is standalone).
function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(text) {
  return escapeData(text).replace(/,/g, '%2C').replace(/:/g, '%3A');
}

// formatAnnotations(result, {maxAnnotations}) -> one ::error line per failing test.
export function formatAnnotations(result, { maxAnnotations = 15 } = {}) {
  return result.failures
    .slice(0, maxAnnotations)
    .map((f) => `::error title=${escapeProperty(f.name)}::${escapeData(firstLine(f.message))}`);
}

function main() {
  const [, , filePath, mode, maxArg] = process.argv;
  if (!filePath || !['table', 'annotations'].includes(mode)) {
    console.error('usage: node summarize-junit.mjs <junit-xml-file> table|annotations [maxAnnotations]');
    process.exit(1);
  }

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`could not read JUnit file '${filePath}': ${err.message}`);
    process.exit(1);
  }

  let result;
  try {
    result = parseJunit(text);
  } catch (err) {
    console.error(`could not parse '${filePath}' as JUnit XML: ${err.message}`);
    process.exit(1);
  }

  if (mode === 'table') {
    console.log(formatTable(result));
    return;
  }
  const maxAnnotations = maxArg ? Number(maxArg) : 15;
  for (const line of formatAnnotations(result, { maxAnnotations })) {
    console.log(line);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
