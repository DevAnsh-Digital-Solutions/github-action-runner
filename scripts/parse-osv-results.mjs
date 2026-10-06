#!/usr/bin/env node
// scripts/parse-osv-results.mjs
//
// Classifies severity for every vulnerability in an `osv-scanner --format
// json` results file, and compares the count at-or-above a threshold
// severity. Used by .github/actions/dependency-scan/action.yml, and
// unit-tested directly in tests/test_parse-osv-results.mjs — this is a
// threshold-check helper script, same category as parse-coverage.mjs, kept
// out of the action's shell so the severity logic is testable and doesn't
// depend on jq (which can't be exercised in this repo's own test suite).
//
// Usage: node parse-osv-results.mjs <osv-json-file> <threshold-severity>
// Prints: {"total":N,"unknown":N,"atOrAboveThreshold":N,"counts":{...}}
// Exits 0 once the file is successfully parsed, regardless of the count —
// the caller decides what to do with it. Exits 1 (message on stderr) if
// the file can't be read or isn't recognizable osv-scanner JSON output.
//
// Severity classification, in priority order:
//   1. `database_specific.severity` (a plain LOW/MODERATE/HIGH/CRITICAL
//      string) when present — this covers the large majority of npm
//      ecosystem advisories, which mirror GHSA data that carries this field.
//   2. A bare numeric CVSS_V3/CVSS_V4 `severity[].score` (some OSV entries
//      store a plain base score number rather than a full vector string),
//      bucketed via the standard CVSS qualitative ranges.
//   3. Otherwise "UNKNOWN". We deliberately do NOT attempt to compute a
//      CVSS base score from a full vector string (e.g. "CVSS:3.1/AV:N/...")
//      — that scoring formula is non-trivial and getting it wrong would
//      silently mis-gate a security check, which is worse than reporting
//      the finding as unclassified. UNKNOWN findings are surfaced in the
//      summary but never counted toward the threshold.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RANK = { LOW: 1, MODERATE: 2, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

// severityRank(vuln) -> the vuln's severity bucket rank (1-4), or 0 for UNKNOWN.
export function severityBucket(vuln) {
  const dbSpecific = vuln?.database_specific?.severity;
  if (typeof dbSpecific === 'string' && dbSpecific.toUpperCase() in RANK) {
    return dbSpecific.toUpperCase();
  }
  const cvss = (vuln?.severity ?? []).find(
    (s) => (s.type === 'CVSS_V3' || s.type === 'CVSS_V4') && /^[0-9.]+$/.test(String(s.score)),
  );
  if (cvss) {
    const score = Number(cvss.score);
    if (score >= 9) return 'CRITICAL';
    if (score >= 7) return 'HIGH';
    if (score >= 4) return 'MEDIUM';
    if (score > 0) return 'LOW';
  }
  return 'UNKNOWN';
}

// extractVulnerabilities(osvJson) -> flat array of raw vulnerability objects
// across every scanned package, per osv-scanner's `results[].packages[].vulnerabilities[]` shape.
export function extractVulnerabilities(osvJson) {
  if (!osvJson || typeof osvJson !== 'object' || Array.isArray(osvJson)) {
    throw new Error('expected a JSON object — this does not look like osv-scanner JSON output');
  }
  // A clean scan can omit "results" entirely (or set it to []) — both mean
  // zero vulnerabilities, not a parse failure.
  const results = osvJson.results ?? [];
  if (!Array.isArray(results)) {
    throw new Error('"results" is present but is not an array — this does not look like osv-scanner JSON output');
  }
  const vulns = [];
  for (const result of results) {
    for (const pkg of result.packages ?? []) {
      for (const vuln of pkg.vulnerabilities ?? []) {
        vulns.push(vuln);
      }
    }
  }
  return vulns;
}

// summarize(vulns, thresholdLabel) -> the full JSON payload this script prints.
export function summarize(vulns, thresholdLabel) {
  const threshold = thresholdLabel.toUpperCase();
  if (!(threshold in RANK)) {
    throw new Error(`unknown severity threshold '${thresholdLabel}'. Expected one of: LOW, MEDIUM, HIGH, CRITICAL`);
  }
  const thresholdRank = RANK[threshold];
  const counts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 0 };
  let atOrAboveThreshold = 0;
  for (const vuln of vulns) {
    const bucket = severityBucket(vuln);
    counts[bucket === 'MODERATE' ? 'MEDIUM' : bucket] += 1;
    if (bucket !== 'UNKNOWN' && RANK[bucket] >= thresholdRank) {
      atOrAboveThreshold += 1;
    }
  }
  return {
    total: vulns.length,
    unknown: counts.UNKNOWN,
    atOrAboveThreshold,
    threshold,
    counts,
  };
}

function main() {
  const [, , filePath, thresholdArg] = process.argv;
  if (!filePath || !thresholdArg) {
    console.error('usage: node parse-osv-results.mjs <osv-json-file> <threshold-severity>');
    process.exit(1);
  }

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`could not read osv-scanner results file '${filePath}': ${err.message}`);
    process.exit(1);
  }

  try {
    const osvJson = JSON.parse(text);
    const vulns = extractVulnerabilities(osvJson);
    const result = summarize(vulns, thresholdArg);
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    console.error(`could not parse osv-scanner results file '${filePath}': ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
