#!/usr/bin/env node
// scripts/parse-osv-results.mjs
//
// Classifies severity for every vulnerability in an `osv-scanner --format
// json` results file, compares the count at-or-above a threshold severity,
// and renders the per-vulnerability findings table (Severity | Package |
// Installed | Vulnerability | Fixed in, highest severity first). Used by
// .github/actions/dependency-scan/action.yml, and unit-tested directly in
// tests/test_parse-osv-results.mjs — this is a threshold-check helper
// script, same category as parse-coverage.mjs, kept out of the action's
// shell so the severity logic is testable and doesn't depend on jq (which
// can't be exercised in this repo's own test suite).
//
// Usage:
//   node parse-osv-results.mjs <osv-json-file> <threshold-severity>
//       -> prints {"total":N,"unknown":N,"atOrAboveThreshold":N,"threshold":"HIGH","counts":{...}}
//   node parse-osv-results.mjs <osv-json-file> <threshold-severity> markdown
//       -> prints the findings table as markdown (for $GITHUB_STEP_SUMMARY)
//   node parse-osv-results.mjs <osv-json-file> <threshold-severity> text
//       -> prints the findings table as aligned plain text (for a step log)
// Exits 0 once the file is successfully parsed, regardless of the count —
// the caller decides what to do with it. Exits 1 (message on stderr) if
// the file can't be read or isn't recognizable osv-scanner JSON output.
//
// One finding = one real vulnerability, not one OSV record. The same
// vulnerability is commonly published under several IDs (for PyPI: a
// GHSA-… record, a PYSEC-… record and a CVE alias), and osv-scanner lists
// every record. Records of the same package that share an ID or alias are
// merged into a single finding so counts and the table aren't inflated.
//
// Severity classification, in priority order, per merged finding (the
// highest severity among its records wins):
//   1. `database_specific.severity` (a plain LOW/MODERATE/HIGH/CRITICAL
//      string) when present — this covers the large majority of npm and
//      PyPI advisories, which mirror GHSA data that carries this field.
//   2. A bare numeric CVSS_V3/CVSS_V4 `severity[].score` (some OSV entries
//      store a plain base score number rather than a full vector string),
//      bucketed via the standard CVSS qualitative ranges.
//   3. The numeric `max_severity` osv-scanner itself computed for the
//      finding's group (`packages[].groups[]`), when present.
//   4. Otherwise "UNKNOWN". We deliberately do NOT attempt to compute a
//      CVSS base score from a full vector string (e.g. "CVSS:3.1/AV:N/...")
//      — that scoring formula is non-trivial and getting it wrong would
//      silently mis-gate a security check, which is worse than reporting
//      the finding as unclassified. UNKNOWN findings are surfaced in the
//      summary but never counted toward the threshold.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RANK = { LOW: 1, MODERATE: 2, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

// bucketFromScore(score) -> 'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'|'UNKNOWN' via the
// standard CVSS qualitative ranges, for a bare numeric base score.
function bucketFromScore(score) {
  if (score >= 9) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'UNKNOWN';
}

// severityBucket(vuln) -> the vuln's severity bucket label, or 'UNKNOWN'.
export function severityBucket(vuln) {
  const dbSpecific = vuln?.database_specific?.severity;
  if (typeof dbSpecific === 'string' && dbSpecific.toUpperCase() in RANK) {
    return dbSpecific.toUpperCase();
  }
  const cvss = (vuln?.severity ?? []).find(
    (s) => (s.type === 'CVSS_V3' || s.type === 'CVSS_V4') && /^[0-9.]+$/.test(String(s.score)),
  );
  if (cvss) {
    return bucketFromScore(Number(cvss.score));
  }
  return 'UNKNOWN';
}

// normalizeBucket(label) -> collapses MODERATE into MEDIUM so every consumer
// works with exactly LOW/MEDIUM/HIGH/CRITICAL/UNKNOWN.
function normalizeBucket(label) {
  return label === 'MODERATE' ? 'MEDIUM' : label;
}

// rankOf(label) -> 0 for UNKNOWN, 1-4 otherwise.
function rankOf(label) {
  return RANK[label] ?? 0;
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

// tallyBuckets(buckets, thresholdLabel) -> the summary payload shared by the
// raw-record and merged-finding entry points below.
function tallyBuckets(buckets, thresholdLabel) {
  const threshold = thresholdLabel.toUpperCase();
  if (!(threshold in RANK)) {
    throw new Error(`unknown severity threshold '${thresholdLabel}'. Expected one of: LOW, MEDIUM, HIGH, CRITICAL`);
  }
  const thresholdRank = RANK[threshold];
  const counts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 0 };
  let atOrAboveThreshold = 0;
  for (const raw of buckets) {
    const bucket = normalizeBucket(raw);
    counts[bucket] += 1;
    if (bucket !== 'UNKNOWN' && rankOf(bucket) >= thresholdRank) {
      atOrAboveThreshold += 1;
    }
  }
  return {
    total: buckets.length,
    unknown: counts.UNKNOWN,
    atOrAboveThreshold,
    threshold,
    counts,
  };
}

// summarize(vulns, thresholdLabel) -> summary payload, one entry per raw record.
export function summarize(vulns, thresholdLabel) {
  return tallyBuckets(vulns.map(severityBucket), thresholdLabel);
}

// summarizeFindings(findings, thresholdLabel) -> summary payload, one entry per
// merged finding (see extractFindings).
export function summarizeFindings(findings, thresholdLabel) {
  return tallyBuckets(findings.map((f) => f.severity), thresholdLabel);
}

// compareVersions(a, b) -> negative/0/positive. A lenient, ecosystem-agnostic
// comparator: splits into numeric and alphabetic runs and compares run by
// run (numbers numerically, letters lexically, a number outranks letters).
// Good enough to order PEP 440 and semver release versions for picking "the
// nearest fixed version above the installed one"; never used for gating.
export function compareVersions(a, b) {
  const tokenize = (v) => String(v).toLowerCase().match(/\d+|[a-z]+/g) ?? [];
  const ta = tokenize(a);
  const tb = tokenize(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i += 1) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return /^\d+$/.test(y) ? (Number(y) === 0 ? 0 : -1) : 1; // 1.0 < 1.0.1, but 1.0 > 1.0rc1
    if (y === undefined) return /^\d+$/.test(x) ? (Number(x) === 0 ? 0 : 1) : -1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? 1 : -1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// fixedVersion(vulns, pkgName, installed) -> the version that fixes the
// finding for the installed version, or null if the advisory names none.
// Only ECOSYSTEM/SEMVER ranges are read: GIT ranges carry commit hashes in
// their `fixed` events, which are not installable versions.
export function fixedVersion(vulns, pkgName, installed) {
  const candidates = [];
  for (const vuln of vulns) {
    for (const affected of vuln.affected ?? []) {
      if (affected.package?.name && affected.package.name.toLowerCase() !== String(pkgName).toLowerCase()) continue;
      for (const range of affected.ranges ?? []) {
        if (range.type !== 'ECOSYSTEM' && range.type !== 'SEMVER') continue;
        let introduced = null;
        for (const event of range.events ?? []) {
          if (event.introduced !== undefined) {
            introduced = event.introduced;
          } else if (event.fixed !== undefined) {
            const afterIntro = introduced === null || introduced === '0' || compareVersions(installed, introduced) >= 0;
            const beforeFix = compareVersions(installed, event.fixed) < 0;
            // Prefer the interval that actually contains the installed version.
            if (afterIntro && beforeFix) candidates.push({ version: event.fixed, contains: true });
            else if (beforeFix) candidates.push({ version: event.fixed, contains: false });
            introduced = null;
          }
        }
      }
    }
  }
  const pool = candidates.some((c) => c.contains) ? candidates.filter((c) => c.contains) : candidates;
  if (pool.length === 0) return null;
  // Several records may disagree; the highest fix among the containing
  // intervals is the one that clears every record of the merged finding.
  return pool.map((c) => c.version).sort(compareVersions).pop();
}

// clusterVulns(vulns) -> array of arrays: records sharing an id or alias are
// merged (union-find over every id/alias string).
function clusterVulns(vulns) {
  const parent = vulns.map((_, i) => i);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const owner = new Map();
  vulns.forEach((vuln, i) => {
    for (const key of [vuln.id, ...(vuln.aliases ?? [])].filter(Boolean)) {
      if (owner.has(key)) parent[find(i)] = find(owner.get(key));
      else owner.set(key, i);
    }
  });
  const groups = new Map();
  vulns.forEach((vuln, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(vuln);
  });
  return [...groups.values()];
}

// extractFindings(osvJson) -> merged findings, sorted highest severity first:
//   {severity, package, version, ecosystem, id, cve, fixedIn}
export function extractFindings(osvJson) {
  if (!osvJson || typeof osvJson !== 'object' || Array.isArray(osvJson)) {
    throw new Error('expected a JSON object — this does not look like osv-scanner JSON output');
  }
  const results = osvJson.results ?? [];
  if (!Array.isArray(results)) {
    throw new Error('"results" is present but is not an array — this does not look like osv-scanner JSON output');
  }
  const findings = [];
  for (const result of results) {
    for (const pkg of result.packages ?? []) {
      const name = pkg.package?.name ?? '(unknown package)';
      const version = pkg.package?.version ?? '(unknown)';
      for (const records of clusterVulns(pkg.vulnerabilities ?? [])) {
        const allIds = new Set(records.flatMap((v) => [v.id, ...(v.aliases ?? [])]).filter(Boolean));

        let severity = 'UNKNOWN';
        for (const record of records) {
          const bucket = normalizeBucket(severityBucket(record));
          if (rankOf(bucket) > rankOf(severity)) severity = bucket;
        }
        if (severity === 'UNKNOWN') {
          // osv-scanner's own computed score for the group, if it gave one.
          for (const group of pkg.groups ?? []) {
            if ((group.ids ?? []).some((id) => allIds.has(id)) && /^[0-9.]+$/.test(String(group.max_severity ?? ''))) {
              const bucket = bucketFromScore(Number(group.max_severity));
              if (rankOf(bucket) > rankOf(severity)) severity = bucket;
            }
          }
        }

        const ids = [...allIds];
        // Prefer a GHSA id as the headline (it links to the advisory with the
        // fix details), then a CVE, then whatever the first record was.
        const id = ids.find((x) => x.startsWith('GHSA-')) ?? ids.find((x) => x.startsWith('CVE-')) ?? records[0].id;
        const cve = ids.find((x) => x.startsWith('CVE-'));
        findings.push({
          severity,
          package: name,
          version,
          ecosystem: pkg.package?.ecosystem ?? '',
          id,
          cve: cve && cve !== id ? cve : null,
          fixedIn: fixedVersion(records, name, version),
        });
      }
    }
  }
  findings.sort(
    (a, b) =>
      rankOf(b.severity) - rankOf(a.severity) ||
      a.package.localeCompare(b.package) ||
      a.id.localeCompare(b.id),
  );
  return findings;
}

const HEADERS = ['Severity', 'Package', 'Installed', 'Vulnerability', 'Fixed in'];

function rowCells(f, { link }) {
  const vuln = link ? `[${f.id}](https://osv.dev/${f.id})` : f.id;
  return [f.severity, f.package, f.version, f.cve ? `${vuln} (${f.cve})` : vuln, f.fixedIn ?? 'no fix available'];
}

// formatFindingsMarkdown(findings) -> markdown table for $GITHUB_STEP_SUMMARY.
export function formatFindingsMarkdown(findings, { maxRows = 100 } = {}) {
  if (findings.length === 0) return 'No vulnerabilities found.';
  const rows = findings.slice(0, maxRows).map((f) => `| ${rowCells(f, { link: true }).join(' | ')} |`);
  const table = [`| ${HEADERS.join(' | ')} |`, `|${HEADERS.map(() => '---').join('|')}|`, ...rows].join('\n');
  if (findings.length > maxRows) {
    return `${table}\n\n_${findings.length - maxRows} more finding(s) not shown — see the uploaded SARIF artifact._`;
  }
  return table;
}

// formatFindingsText(findings) -> column-aligned plain text for a step log.
export function formatFindingsText(findings) {
  if (findings.length === 0) return 'No vulnerabilities found.';
  const rows = findings.map((f) => rowCells(f, { link: false }));
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(HEADERS), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function main() {
  const [, , filePath, thresholdArg, mode] = process.argv;
  if (!filePath || !thresholdArg || (mode !== undefined && !['markdown', 'text'].includes(mode))) {
    console.error('usage: node parse-osv-results.mjs <osv-json-file> <threshold-severity> [markdown|text]');
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
    const findings = extractFindings(JSON.parse(text));
    if (mode === 'markdown') {
      console.log(formatFindingsMarkdown(findings));
    } else if (mode === 'text') {
      console.log(formatFindingsText(findings));
    } else {
      console.log(JSON.stringify(summarizeFindings(findings, thresholdArg)));
    }
    process.exit(0);
  } catch (err) {
    console.error(`could not parse osv-scanner results file '${filePath}': ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
