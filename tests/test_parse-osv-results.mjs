#!/usr/bin/env node
// tests/test_parse-osv-results.mjs
//
// Unit tests for scripts/parse-osv-results.mjs. Run directly:
//   node tests/test_parse-osv-results.mjs

import assert from 'node:assert/strict';
import {
  severityBucket,
  extractVulnerabilities,
  summarize,
} from '../scripts/parse-osv-results.mjs';

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

test('severityBucket reads database_specific.severity', () => {
  assert.equal(severityBucket({ database_specific: { severity: 'HIGH' } }), 'HIGH');
  assert.equal(severityBucket({ database_specific: { severity: 'moderate' } }), 'MODERATE');
});

test('severityBucket falls back to a bare numeric CVSS_V3 score', () => {
  assert.equal(severityBucket({ severity: [{ type: 'CVSS_V3', score: '9.8' }] }), 'CRITICAL');
  assert.equal(severityBucket({ severity: [{ type: 'CVSS_V3', score: '7.5' }] }), 'HIGH');
  assert.equal(severityBucket({ severity: [{ type: 'CVSS_V3', score: '5.0' }] }), 'MEDIUM');
  assert.equal(severityBucket({ severity: [{ type: 'CVSS_V3', score: '2.1' }] }), 'LOW');
});

test('severityBucket does not attempt to score a full CVSS vector string', () => {
  assert.equal(severityBucket({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }), 'UNKNOWN');
});

test('severityBucket returns UNKNOWN when there is no usable severity data', () => {
  assert.equal(severityBucket({}), 'UNKNOWN');
});

test('extractVulnerabilities flattens results[].packages[].vulnerabilities[]', () => {
  const osvJson = {
    results: [
      { packages: [{ vulnerabilities: [{ id: 'A' }, { id: 'B' }] }, { vulnerabilities: [{ id: 'C' }] }] },
      { packages: [{ vulnerabilities: [] }] },
    ],
  };
  const vulns = extractVulnerabilities(osvJson);
  assert.deepEqual(vulns.map((v) => v.id), ['A', 'B', 'C']);
});

test('extractVulnerabilities treats a missing "results" key as a clean scan, not an error', () => {
  assert.deepEqual(extractVulnerabilities({}), []);
});

test('extractVulnerabilities throws on non-object input', () => {
  assert.throws(() => extractVulnerabilities([1, 2, 3]), /expected a JSON object/);
  assert.throws(() => extractVulnerabilities(null), /expected a JSON object/);
});

test('summarize counts severities and gates at-or-above the threshold', () => {
  const vulns = [
    { database_specific: { severity: 'LOW' } },
    { database_specific: { severity: 'MODERATE' } },
    { database_specific: { severity: 'HIGH' } },
    { database_specific: { severity: 'CRITICAL' } },
    {},
  ];
  const result = summarize(vulns, 'HIGH');
  assert.equal(result.total, 5);
  assert.equal(result.unknown, 1);
  assert.equal(result.atOrAboveThreshold, 2);
  assert.deepEqual(result.counts, { LOW: 1, MEDIUM: 1, HIGH: 1, CRITICAL: 1, UNKNOWN: 1 });
});

test('summarize never counts UNKNOWN toward the threshold, even at the lowest threshold', () => {
  const result = summarize([{}, {}], 'LOW');
  assert.equal(result.atOrAboveThreshold, 0);
  assert.equal(result.unknown, 2);
});

test('summarize throws on an unrecognized threshold label', () => {
  assert.throws(() => summarize([], 'SEVERE'), /unknown severity threshold/);
});

test('summarize is case-insensitive for the threshold label', () => {
  const result = summarize([{ database_specific: { severity: 'HIGH' } }], 'high');
  assert.equal(result.atOrAboveThreshold, 1);
});

if (failures === 0) {
  console.log('All tests passed.');
  process.exit(0);
} else {
  console.log(`${failures} test(s) failed.`);
  process.exit(1);
}
