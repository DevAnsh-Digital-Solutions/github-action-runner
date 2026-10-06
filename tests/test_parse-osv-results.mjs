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
  summarizeFindings,
  compareVersions,
  fixedVersion,
  extractFindings,
  formatFindingsMarkdown,
  formatFindingsText,
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

// --- merged findings / table -------------------------------------------------
// Shapes below mirror real api.osv.dev records for PyPI requests 2.19.0: one
// vulnerability published as GHSA + PYSEC records that alias each other, the
// PYSEC record carrying no severity and a GIT range whose `fixed` is a commit.
const ghsaRecord = {
  id: 'GHSA-x84v-xcm2-53pg',
  aliases: ['CVE-2018-18074', 'PYSEC-2018-28'],
  database_specific: { severity: 'HIGH' },
  affected: [{ package: { name: 'requests', ecosystem: 'PyPI' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.20.0' }] }] }],
};
const pysecRecord = {
  id: 'PYSEC-2018-28',
  aliases: ['CVE-2018-18074', 'GHSA-x84v-xcm2-53pg'],
  affected: [{
    package: { name: 'requests', ecosystem: 'PyPI' },
    ranges: [
      { type: 'GIT', events: [{ introduced: '0' }, { fixed: 'c45d7c49ea75133e52ab22a8e9e13173938e36ff' }] },
      { type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.20.0' }] },
    ],
  }],
};
const moderateRecord = {
  id: 'GHSA-j8r2-6x86-q33q',
  aliases: ['CVE-2023-32681'],
  database_specific: { severity: 'MODERATE' },
  affected: [{ package: { name: 'requests', ecosystem: 'PyPI' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '2.3.0' }, { fixed: '2.31.0' }] }] }],
};
const OSV_SAMPLE = {
  results: [{
    source: { path: '/w/requirements.txt', type: 'lockfile' },
    packages: [
      { package: { name: 'requests', version: '2.19.0', ecosystem: 'PyPI' }, vulnerabilities: [moderateRecord, ghsaRecord, pysecRecord] },
      { package: { name: 'jinja2', version: '2.10', ecosystem: 'PyPI' }, vulnerabilities: [{ id: 'PYSEC-X', aliases: [] }] },
    ],
  }],
};

test('compareVersions orders numeric, multi-digit and pre-release versions', () => {
  assert.ok(compareVersions('2.9', '2.10') < 0);
  assert.ok(compareVersions('2.20.0', '2.19.0') > 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0rc1', '1.0') < 0);
  assert.ok(compareVersions('1.0', '1.0.1') < 0);
});

test('fixedVersion reads the ECOSYSTEM range and ignores GIT commit hashes', () => {
  assert.equal(fixedVersion([pysecRecord], 'requests', '2.19.0'), '2.20.0');
});

test('fixedVersion picks the interval that contains the installed version', () => {
  const vuln = {
    affected: [{ package: { name: 'pkg' }, ranges: [{ type: 'ECOSYSTEM', events: [
      { introduced: '0' }, { fixed: '1.5.0' }, { introduced: '2.0.0' }, { fixed: '2.3.0' },
    ] }] }],
  };
  assert.equal(fixedVersion([vuln], 'pkg', '1.2.0'), '1.5.0');
  assert.equal(fixedVersion([vuln], 'pkg', '2.1.0'), '2.3.0');
});

test('fixedVersion returns null when the advisory names no fix', () => {
  const vuln = { affected: [{ package: { name: 'pkg' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] }] }] };
  assert.equal(fixedVersion([vuln], 'pkg', '1.0.0'), null);
  assert.equal(fixedVersion([{}], 'pkg', '1.0.0'), null);
});

test('extractFindings merges GHSA/PYSEC/CVE records of one vulnerability into one finding', () => {
  const findings = extractFindings(OSV_SAMPLE);
  assert.equal(findings.length, 3); // 2 requests vulns (3 records) + 1 jinja2
  const high = findings.find((f) => f.id === 'GHSA-x84v-xcm2-53pg');
  assert.equal(high.severity, 'HIGH'); // PYSEC record has none; the GHSA one wins
  assert.equal(high.cve, 'CVE-2018-18074');
  assert.equal(high.package, 'requests');
  assert.equal(high.version, '2.19.0');
  assert.equal(high.fixedIn, '2.20.0');
});

test('extractFindings sorts highest severity first, UNKNOWN last', () => {
  assert.deepEqual(extractFindings(OSV_SAMPLE).map((f) => f.severity), ['HIGH', 'MEDIUM', 'UNKNOWN']);
});

test('extractFindings falls back to osv-scanner group max_severity when records carry none', () => {
  const osv = { results: [{ packages: [{
    package: { name: 'p', version: '1.0', ecosystem: 'PyPI' },
    vulnerabilities: [{ id: 'PYSEC-1', aliases: [] }],
    groups: [{ ids: ['PYSEC-1'], max_severity: '9.8' }],
  }] }] };
  assert.equal(extractFindings(osv)[0].severity, 'CRITICAL');
});

test('extractFindings does not merge same-id records across different packages', () => {
  const osv = { results: [{ packages: [
    { package: { name: 'a', version: '1', ecosystem: 'npm' }, vulnerabilities: [{ id: 'GHSA-1', aliases: [] }] },
    { package: { name: 'b', version: '1', ecosystem: 'npm' }, vulnerabilities: [{ id: 'GHSA-1', aliases: [] }] },
  ] }] };
  assert.equal(extractFindings(osv).length, 2);
});

test('extractFindings returns [] for a clean scan and throws on non-object input', () => {
  assert.deepEqual(extractFindings({}), []);
  assert.throws(() => extractFindings(null), /expected a JSON object/);
});

test('summarizeFindings counts merged findings, not raw records, and gates on the threshold', () => {
  const result = summarizeFindings(extractFindings(OSV_SAMPLE), 'HIGH');
  assert.equal(result.total, 3);
  assert.deepEqual(result.counts, { LOW: 0, MEDIUM: 1, HIGH: 1, CRITICAL: 0, UNKNOWN: 1 });
  assert.equal(result.atOrAboveThreshold, 1);
});

test('formatFindingsMarkdown emits the required columns with linked ids', () => {
  const table = formatFindingsMarkdown(extractFindings(OSV_SAMPLE));
  const lines = table.split('\n');
  assert.equal(lines[0], '| Severity | Package | Installed | Vulnerability | Fixed in |');
  assert.equal(lines[2], '| HIGH | requests | 2.19.0 | [GHSA-x84v-xcm2-53pg](https://osv.dev/GHSA-x84v-xcm2-53pg) (CVE-2018-18074) | 2.20.0 |');
  assert.match(table, /no fix available/);
});

test('formatFindingsMarkdown caps rows and says how many were cut', () => {
  const findings = Array.from({ length: 5 }, (_, i) => ({ severity: 'HIGH', package: `p${i}`, version: '1', id: `GHSA-${i}`, cve: null, fixedIn: '2' }));
  const table = formatFindingsMarkdown(findings, { maxRows: 2 });
  assert.match(table, /3 more finding\(s\) not shown/);
});

test('formatFindingsText aligns columns and puts the highest severity first', () => {
  const lines = formatFindingsText(extractFindings(OSV_SAMPLE)).split('\n');
  assert.match(lines[0], /^Severity\s+Package\s+Installed\s+Vulnerability\s+Fixed in$/);
  assert.match(lines[2], /^HIGH\s+requests\s+2\.19\.0\s+GHSA-x84v-xcm2-53pg \(CVE-2018-18074\)\s+2\.20\.0$/);
  assert.equal(lines[2].indexOf('requests'), lines[3].indexOf('requests'));
});

test('formatters report a clean scan plainly', () => {
  assert.equal(formatFindingsMarkdown([]), 'No vulnerabilities found.');
  assert.equal(formatFindingsText([]), 'No vulnerabilities found.');
});

if (failures === 0) {
  console.log('All tests passed.');
  process.exit(0);
} else {
  console.log(`${failures} test(s) failed.`);
  process.exit(1);
}
