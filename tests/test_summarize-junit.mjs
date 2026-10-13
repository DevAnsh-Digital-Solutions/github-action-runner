#!/usr/bin/env node
// tests/test_summarize-junit.mjs
//
// Unit tests for scripts/summarize-junit.mjs. Run directly:
//   node tests/test_summarize-junit.mjs

import assert from 'node:assert/strict';
import {
  unescapeXml,
  parseJunit,
  formatTable,
  formatAnnotations,
} from '../scripts/summarize-junit.mjs';

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

// Trimmed from real `pytest --junitxml` output: two failures (one multi-line
// message with numeric entity newlines, one with escaped <&>), one skip, two passes.
const FAILING_XML = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="2" skipped="1" tests="5" time="0.189"><testcase classname="tests.test_bad" name="test_wrong" time="0.001"><failure message="assert 4 == 5&#10; +  where 4 = add(2, 2)">def test_wrong():
&gt;       assert add(2, 2) == 5
E       assert 4 == 5</failure></testcase><testcase classname="tests.test_bad" name="test_boom" time="0.001"><failure message="RuntimeError: kaboom &lt;&amp;&gt;">trace</failure></testcase><testcase classname="tests.test_bad" name="test_skipped" time="0.000"><skipped type="pytest.skip" message="x">skip detail</skipped></testcase><testcase classname="tests.test_basic" name="test_a" time="0.000" /><testcase classname="tests.test_basic" name="test_b" time="0.000" /></testsuite></testsuites>`;

const PASSING_XML = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="2" time="0.1"><testcase classname="t" name="a" time="0" /><testcase classname="t" name="b" time="0" /></testsuite></testsuites>`;

test('unescapeXml decodes named and numeric entities, ampersand last', () => {
  assert.equal(unescapeXml('a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#10;e &#x41;'), 'a <b> & "c" \'d\' \ne A');
  assert.equal(unescapeXml('&amp;lt;'), '&lt;');
});

test('parseJunit reads totals from the testsuite attributes', () => {
  const r = parseJunit(FAILING_XML);
  assert.equal(r.total, 5);
  assert.equal(r.failed, 2);
  assert.equal(r.skipped, 1);
  assert.equal(r.passed, 2);
});

test('parseJunit lists failing tests by classname.name with decoded messages', () => {
  const r = parseJunit(FAILING_XML);
  assert.deepEqual(r.failures.map((f) => f.name), ['tests.test_bad.test_wrong', 'tests.test_bad.test_boom']);
  assert.equal(r.failures[1].message, 'RuntimeError: kaboom <&>');
  assert.match(r.failures[0].message, /^assert 4 == 5\n/);
});

test('parseJunit does not report skipped or passing testcases as failures', () => {
  assert.equal(parseJunit(PASSING_XML).failures.length, 0);
  assert.equal(parseJunit(FAILING_XML).failures.some((f) => f.name.includes('skipped')), false);
});

test('parseJunit counts errors as failed and sums multiple testsuites', () => {
  const xml = '<testsuites><testsuite tests="3" failures="1" errors="1" skipped="0"></testsuite><testsuite tests="2" failures="0" errors="0" skipped="1"></testsuite></testsuites>';
  const r = parseJunit(xml);
  assert.equal(r.total, 5);
  assert.equal(r.failed, 2);
  assert.equal(r.errors, 1);
  assert.equal(r.passed, 2);
});

test('parseJunit accepts a self-closing empty testsuite (pytest with no tests)', () => {
  const r = parseJunit('<testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="0" /></testsuites>');
  assert.equal(r.total, 0);
});

test('parseJunit throws when there is no testsuite element', () => {
  assert.throws(() => parseJunit('<html></html>'), /no <testsuite> element/);
  assert.throws(() => parseJunit('<testsuites></testsuites>'), /no <testsuite> element/);
});

test('formatTable emits the totals row and a failing-tests table with first-line messages', () => {
  const table = formatTable(parseJunit(FAILING_XML));
  const lines = table.split('\n');
  assert.equal(lines[0], '| Total | Passed | Failed | Skipped |');
  assert.equal(lines[2], '| 5 | 2 | 2 | 1 |');
  assert.match(table, /\| Failing test \| Message \|/);
  assert.match(table, /\| tests\.test_bad\.test_wrong \| assert 4 == 5 \|/);
  assert.match(table, /\| tests\.test_bad\.test_boom \| RuntimeError: kaboom &lt;&> \|/);
});

test('formatTable omits the failing-tests table when everything passed', () => {
  assert.doesNotMatch(formatTable(parseJunit(PASSING_XML)), /Failing test/);
});

test('formatTable caps the failing rows and says how many were cut', () => {
  const result = { total: 10, passed: 0, failed: 10, skipped: 0, failures: Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, message: 'm' })) };
  assert.match(formatTable(result, { maxRows: 3 }), /7 more failing test\(s\) not shown/);
});

test('formatTable escapes pipes so a message cannot break the table', () => {
  const result = { total: 1, passed: 0, failed: 1, skipped: 0, failures: [{ name: 'a|b', message: 'x | y' }] };
  assert.match(formatTable(result), /\| a\\\|b \| x \\\| y \|/);
});

test('formatAnnotations emits one escaped ::error per failing test, capped', () => {
  const result = parseJunit(FAILING_XML);
  const lines = formatAnnotations(result);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '::error title=tests.test_bad.test_wrong::assert 4 == 5');
  assert.equal(formatAnnotations(result, { maxAnnotations: 1 }).length, 1);
  const tricky = { failures: [{ name: 'a,b:c', message: '100%\nnext' }] };
  assert.equal(formatAnnotations(tricky)[0], '::error title=a%2Cb%3Ac::100%25');
});

if (failures === 0) {
  console.log('All tests passed.');
  process.exit(0);
} else {
  console.log(`${failures} test(s) failed.`);
  process.exit(1);
}
