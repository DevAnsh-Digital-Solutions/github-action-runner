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
//   node summarize-sarif.mjs <sarif-file> count
//   node summarize-sarif.mjs <sarif-file> relativize [out-file]
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
// "count" mode prints the number of results — lets a caller tell a tool that
// exited non-zero because it found something from one that crashed before
// it found anything (some tools, e.g. ruff, use exit code 1 for both).
// "relativize" mode rewrites every absolute file:// artifact URI under
// $GITHUB_WORKSPACE to a repo-relative path (in place unless out-file is
// given). Some tools (ruff) emit absolute URIs; GitHub annotations and code
// scanning both want repo-relative ones. Annotations/table output is always
// relativized the same way, without needing this mode.
//
// Exits 0 once the file is successfully parsed as SARIF-shaped JSON,
// regardless of finding count. Exits 1 (message on stderr) if the file
// can't be read or doesn't look like SARIF output.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// toRepoRelativePath(uri, workspace) -> a repo-relative path when `uri` is an
// absolute file:// URI under `workspace` (handles POSIX and Windows drive
// forms, percent-encoding and backslashes); any other uri — already relative,
// or outside the workspace — is returned unchanged.
export function toRepoRelativePath(uri, workspace) {
  if (typeof uri !== 'string' || !uri.startsWith('file:') || !workspace) return uri;
  let path = uri.replace(/^file:\/\/\/?/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    return uri; // malformed percent-encoding: leave it alone rather than guess
  }
  path = path.replace(/\\/g, '/');
  const isDrivePath = (x) => /^[A-Za-z]:\//.test(x);
  // file:///C:/x -> "C:/x" (drive form, no leading slash); file:///home/x -> "/home/x"
  if (!isDrivePath(path)) path = `/${path}`;
  const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const fold = (x) => (isDrivePath(x) ? x.toLowerCase() : x); // drive letters are case-insensitive
  if (fold(path).startsWith(`${fold(root)}/`)) return path.slice(root.length + 1);
  return uri;
}

// extractResults(sarifJson, opts) -> flat array of {ruleId, level, message, file, line}
// across every run in the file (SARIF allows multiple `runs`; every tool we
// invoke produces exactly one, but we don't assume that here). File paths
// are made repo-relative against opts.workspace (default $GITHUB_WORKSPACE).
export function extractResults(sarifJson, { workspace = process.env.GITHUB_WORKSPACE } = {}) {
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
        file: toRepoRelativePath(location?.artifactLocation?.uri, workspace) ?? '(unknown file)',
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

// relativizeSarif(sarifJson, workspace) -> the same object with every
// artifactLocation.uri made repo-relative (mutates and returns it).
export function relativizeSarif(sarifJson, workspace) {
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      if (node.artifactLocation && typeof node.artifactLocation.uri === 'string') {
        node.artifactLocation.uri = toRepoRelativePath(node.artifactLocation.uri, workspace);
      }
      Object.values(node).forEach(walk);
    }
  };
  walk(sarifJson);
  return sarifJson;
}

function main() {
  const [, , filePath, mode, ...rest] = process.argv;
  if (!filePath || !['table', 'annotations', 'count', 'relativize'].includes(mode)) {
    console.error('usage: node summarize-sarif.mjs <sarif-file> table|annotations|count|relativize [maxAnnotations|out-file] [--no-message]');
    process.exit(1);
  }

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`could not read SARIF file '${filePath}': ${err.message}`);
    process.exit(1);
  }

  if (mode === 'relativize') {
    try {
      const out = rest.find((a) => !a.startsWith('--')) ?? filePath;
      writeFileSync(out, JSON.stringify(relativizeSarif(JSON.parse(text), process.env.GITHUB_WORKSPACE), null, 2));
    } catch (err) {
      console.error(`could not relativize '${filePath}': ${err.message}`);
      process.exit(1);
    }
    return;
  }

  let results;
  try {
    results = extractResults(JSON.parse(text));
  } catch (err) {
    console.error(`could not parse '${filePath}' as SARIF: ${err.message}`);
    process.exit(1);
  }

  if (mode === 'count') {
    console.log(results.length);
    return;
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
