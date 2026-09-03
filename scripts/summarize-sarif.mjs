#!/usr/bin/env node
// scripts/summarize-sarif.mjs
//
// Turns a SARIF 2.1.0 results file into (a) a markdown findings table for
// $GITHUB_STEP_SUMMARY and (b) capped GitHub Actions annotation commands
// (::error/::warning/::notice file=...,line=...,title=...::message), so a
// scanning action still gives a developer real, actionable output when
// GitHub's own SARIF ingestion (`upload-sarif`) is unavailable — e.g. no
// GitHub Code Security license on a private repo. Used by
// .github/actions/{lint,dependency-scan,secret-scan}/action.yml, and
// unit-tested directly in tests/test_summarize-sarif.mjs.
//
// Usage:
//   node summarize-sarif.mjs <sarif-file> table
//   node summarize-sarif.mjs <sarif-file> annotations [maxAnnotations] [--no-message]
//
// "table" mode prints a markdown table to stdout (or "No findings." if
// there are none) — callers append it to $GITHUB_STEP_SUMMARY themselves.
// "annotations" mode prints one workflow-command line per finding, capped
// at maxAnnotations (default 15) so a run with hundreds of findings doesn't
// flood the log — the table already covers the rest. Pass --no-message to
// omit each finding's message text from the annotation (file/line/rule
// only) — secret-scan uses this, since annotations render inline in the PR
// "Files changed" view, a far more visible surface than a downloaded
// artifact, and a gitleaks finding's message can carry more detail about
// the match than should be broadcast that widely.
//
// Exits 0 once the file is successfully parsed as SARIF-shaped JSON,
// regardless of finding count. Exits 1 (message on stderr) if the file
// can't be read or doesn't look like SARIF output.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// extractResults(sarifJson) -> flat array of {ruleId, level, message, file, line}
// across every run in the file (SARIF allows multiple `runs`; every tool we
// invoke produces exactly one, but we don't assume that here).
export function extractResults(sarifJson) {
  if (!sarifJson || typeof sarifJson !== 'object' || Array.isArray(sarifJson)) {
    throw new Error('expected a JSON object — this does not look like SARIF output');
  }
  const runs = sarifJson.runs;
  if (!Array.isArray(runs)) {
    throw new Error('"runs" is missing or is not an array — this does not look like SARIF output');
  }
  const flat = [];
  for (const run of runs) {
    for (const result of run.results ?? []) {
      const location = result.locations?.[0]?.physicalLocation;
      flat.push({
        ruleId: result.ruleId ?? 'unknown-rule',
        // SARIF's own default when a result omits `level` is 'warning'.
        level: result.level ?? 'warning',
        message: result.message?.text ?? '(no message)',
        file: location?.artifactLocation?.uri ?? '(unknown file)',
        line: location?.region?.startLine ?? null,
      });
    }
  }
  return flat;
}

// escapeData(text) -> text safe to place inside a workflow command's ::...::
// message body, per GitHub's escaping rules for the data portion.
export function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// escapeProperty(text) -> text safe to place inside a workflow command's
// key=value property (stricter than escapeData: commas and colons too).
export function escapeProperty(text) {
  return escapeData(text).replace(/,/g, '%2C').replace(/:/g, '%3A');
}

// sarifLevelToCommand(level) -> the workflow command name GitHub recognizes.
export function sarifLevelToCommand(level) {
  if (level === 'error') return 'error';
  if (level === 'note' || level === 'none') return 'notice';
  return 'warning'; // covers 'warning' and any unrecognized value
}

// formatMarkdownTable(results, opts) -> markdown for $GITHUB_STEP_SUMMARY.
export function formatMarkdownTable(results, { maxRows = 50 } = {}) {
  if (results.length === 0) return 'No findings.';
  const shown = results.slice(0, maxRows);
  const rows = shown.map((r) => {
    const location = r.file + (r.line ? `:${r.line}` : '');
    const message = r.message.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    return `| ${r.level} | ${r.ruleId} | ${location} | ${message} |`;
  });
  const header = '| Level | Rule | Location | Message |\n|---|---|---|---|';
  const table = [header, ...rows].join('\n');
  if (results.length > maxRows) {
    return `${table}\n\n_${results.length - maxRows} more finding(s) not shown — see the uploaded SARIF artifact._`;
  }
  return table;
}

// formatAnnotations(results, opts) -> array of workflow-command lines, one
// per finding, capped at maxAnnotations.
export function formatAnnotations(results, { maxAnnotations = 15, includeMessage = true } = {}) {
  return results.slice(0, maxAnnotations).map((r) => {
    const command = sarifLevelToCommand(r.level);
    const props = [`file=${escapeProperty(r.file)}`, `title=${escapeProperty(r.ruleId)}`];
    if (r.line) props.push(`line=${r.line}`);
    const body = includeMessage
      ? escapeData(r.message)
      : escapeData(`rule '${r.ruleId}' — see the uploaded SARIF artifact for details`);
    return `::${command} ${props.join(',')}::${body}`;
  });
}

function main() {
  const [, , filePath, mode, ...rest] = process.argv;
  if (!filePath || !['table', 'annotations'].includes(mode)) {
    console.error('usage: node summarize-sarif.mjs <sarif-file> table|annotations [maxAnnotations] [--no-message]');
    process.exit(1);
  }

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`could not read SARIF file '${filePath}': ${err.message}`);
    process.exit(1);
  }

  let results;
  try {
    results = extractResults(JSON.parse(text));
  } catch (err) {
    console.error(`could not parse '${filePath}' as SARIF: ${err.message}`);
    process.exit(1);
  }

  if (mode === 'table') {
    console.log(formatMarkdownTable(results));
    return;
  }

  const includeMessage = !rest.includes('--no-message');
  const maxArg = rest.find((a) => !a.startsWith('--'));
  const maxAnnotations = maxArg ? Number(maxArg) : 15;
  for (const line of formatAnnotations(results, { maxAnnotations, includeMessage })) {
    console.log(line);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
