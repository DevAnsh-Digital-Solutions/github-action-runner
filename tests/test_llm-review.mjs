#!/usr/bin/env node
// tests/test_llm-review.mjs
//
// Unit tests for scripts/llm-review.mjs. Run directly:
//   node tests/test_llm-review.mjs

import assert from 'node:assert/strict';
import {
  MARKER,
  summarizeLint,
  parseTestJson,
  summarizeTests,
  perFileCoverage,
  summarizeCoverage,
  globToRegExp,
  splitDiff,
  prepareDiff,
  buildPrompt,
  extractJson,
  validateReview,
  sanitize,
  checkStatuses,
  verdict,
  renderMarkdown,
  postComment,
} from '../scripts/llm-review.mjs';

let failures = 0;
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

// --- fixtures ---

const SARIF = JSON.stringify({
  version: '2.1.0',
  runs: [{
    results: [
      { ruleId: 'no-console', level: 'warning', message: { text: 'Unexpected console statement.' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' }, region: { startLine: 3 } } }] },
      { ruleId: 'no-unused-vars', level: 'error', message: { text: "'x' is assigned a value but never used." }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/b.ts' }, region: { startLine: 9 } } }] },
    ],
  }],
});

const JEST = JSON.stringify({
  numTotalTests: 3, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, numTodoTests: 0,
  testResults: [
    { name: '/w/tests/a.test.ts', status: 'failed', assertionResults: [
      { fullName: 'add adds', status: 'passed', failureMessages: [] },
      { fullName: 'add subtracts', status: 'failed', failureMessages: ['\u001b[31mExpected: 1\nReceived: 2\u001b[39m'] },
    ] },
    { name: '/w/tests/broken.test.ts', status: 'failed', message: 'Cannot find module ./x', assertionResults: [] },
  ],
});

const JUNIT = '<?xml version="1.0"?><testsuites><testsuite name="pytest" errors="0" failures="1" skipped="0" tests="2"><testcase classname="tests.test_a" name="test_ok" time="0.01"/><testcase classname="tests.test_a" name="test_bad" time="0.01"><failure message="assert 1 == 2">trace</failure></testcase></testsuite></testsuites>';

const LCOV = 'TN:\nSF:/w/src/a.ts\nLF:10\nLH:2\nend_of_record\nSF:/w/src/b.ts\nLF:10\nLH:10\nend_of_record\nSF:/w/src/c.ts\nLF:4\nLH:3\nend_of_record\n';

const COBERTURA = '<?xml version="1.0"?><coverage line-rate="0.5" lines-valid="10" lines-covered="5" branches-valid="0" branches-covered="0"><packages><package><classes><class name="a" filename="src/a.py" line-rate="0.25"/><class name="b" filename="src/b.py" line-rate="1"/></classes></package></packages></coverage>';

const JSON_SUMMARY = JSON.stringify({
  total: { lines: { total: 10, covered: 5, pct: 50 }, branches: { total: 0, covered: 0 }, functions: { total: 2, covered: 1 } },
  '/w/src/a.ts': { lines: { total: 10, covered: 2, pct: 20 } },
  '/w/src/b.ts': { lines: { total: 10, covered: 10, pct: 100 } },
});

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  '+console.log(1);',
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '+lots of lock noise',
  'diff --git a/src/new file.ts b/src/new file.ts',
  '+++ b/src/new file.ts',
  '+export const y = 1;',
].join('\n');

const good = (over = {}) => ({
  summary: 'Overall fine.',
  sections: {
    lint: { assessment: 'Two lint findings.', items: [{ severity: 'medium', file: 'src/a.ts', line: 3, title: 'Remove console.log', detail: 'Leaks debug output.', fix: 'Delete the line.' }] },
    tests: { assessment: 'All pass.', items: [] },
    coverage: { assessment: 'Low.', items: [] },
    code: { assessment: 'Fine.', items: [] },
    ...over,
  },
});

// --- check summaries ---

test('summarizeLint: counts, sorts errors first, keeps rule/file/line', () => {
  const r = summarizeLint(SARIF, { workspace: '/w' });
  assert.equal(r.total, 2);
  assert.equal(r.errors, 1);
  assert.equal(r.warnings, 1);
  assert.equal(r.findings[0].rule, 'no-unused-vars');
  assert.equal(r.findings[0].file, 'src/b.ts');
  assert.equal(r.findings[0].line, 9);
});

test('summarizeLint: caps the findings handed to the model but keeps the total', () => {
  const r = summarizeLint(SARIF, { workspace: '/w', maxItems: 1 });
  assert.equal(r.findings.length, 1);
  assert.equal(r.total, 2);
});

test('parseTestJson: totals, failing test names, ANSI stripped, failed suite with no cases', () => {
  const r = parseTestJson(JSON.parse(JEST));
  assert.deepEqual([r.total, r.passed, r.failed, r.skipped], [3, 1, 1, 1]);
  assert.equal(r.failures.length, 2);
  assert.equal(r.failures[0].name, 'add subtracts');
  assert.ok(!r.failures[0].message.includes('\u001b'));
  assert.equal(r.failures[1].name, '/w/tests/broken.test.ts');
  assert.match(r.failures[1].message, /Cannot find module/);
  assert.throws(() => parseTestJson({}), /Jest\/Vitest/);
});

test('summarizeTests: picks the parser from the file name', () => {
  assert.equal(summarizeTests(JEST, 'jest-results.json').failed, 1);
  const j = summarizeTests(JUNIT, 'pytest-results.xml');
  assert.equal(j.failed, 1);
  assert.equal(j.failures[0].name, 'tests.test_a.test_bad');
});

test('perFileCoverage: reads lcov, json-summary and cobertura', () => {
  assert.deepEqual(perFileCoverage(LCOV).map((f) => [f.file, f.pct]), [['/w/src/a.ts', 20], ['/w/src/b.ts', 100], ['/w/src/c.ts', 75]]);
  assert.deepEqual(perFileCoverage(JSON_SUMMARY).map((f) => [f.file, f.pct]), [['/w/src/a.ts', 20], ['/w/src/b.ts', 100]]);
  assert.deepEqual(perFileCoverage(COBERTURA).map((f) => [f.file, f.pct]), [['src/a.py', 25], ['src/b.py', 100]]);
  assert.deepEqual(perFileCoverage('garbage'), []);
});

test('summarizeCoverage: absolute lcov paths become repo-relative against the workspace', () => {
  const r = summarizeCoverage(LCOV, 80, { workspace: '/w' });
  assert.deepEqual(r.lowFiles.map((f) => f.file), ['src/a.ts', 'src/c.ts']);
});

test('summarizeCoverage: threshold verdict plus lowest files, preferring the PR\'s own files', () => {
  const r = summarizeCoverage(LCOV, 80, { changedFiles: ['src/c.ts'] });
  assert.equal(r.lines.pct, 62.5);
  assert.equal(r.passed, false);
  assert.deepEqual(r.lowFiles.map((f) => f.file), ['/w/src/c.ts']);
  assert.equal(r.lowFilesAreChangedOnly, true);
  const all = summarizeCoverage(LCOV, 80, { changedFiles: ['unrelated.ts'] });
  assert.deepEqual(all.lowFiles.map((f) => f.file), ['/w/src/a.ts', '/w/src/c.ts']); // 100% file excluded
  assert.equal(all.lowFilesAreChangedOnly, false);
  assert.equal(summarizeCoverage(COBERTURA, 40).passed, true);
});

// --- diff ---

test('globToRegExp: bare names match at any depth, ** crosses directories', () => {
  assert.ok(globToRegExp('package-lock.json').test('package-lock.json'));
  assert.ok(globToRegExp('package-lock.json').test('web/package-lock.json'));
  assert.ok(globToRegExp('*.min.js').test('static/app.min.js'));
  assert.ok(globToRegExp('dist/**').test('dist/a/b.js'));
  assert.ok(!globToRegExp('dist/**').test('src/dist/a.js'));
  assert.ok(globToRegExp('**/dist/**').test('src/dist/a.js'));
  assert.ok(!globToRegExp('*.js').test('a.json'));
});

test('splitDiff: one section per file, including names with spaces', () => {
  const s = splitDiff(DIFF);
  assert.deepEqual(s.map((x) => x.file), ['src/a.ts', 'package-lock.json', 'src/new file.ts']);
  assert.ok(s[0].text.includes('+console.log(1);'));
});

test('prepareDiff: excludes lockfiles and reports them', () => {
  const d = prepareDiff(DIFF, { excludeGlobs: ['package-lock.json'], maxBytes: 100000 });
  assert.deepEqual(d.includedFiles, ['src/a.ts', 'src/new file.ts']);
  assert.deepEqual(d.excludedFiles, ['package-lock.json']);
  assert.equal(d.truncated, false);
  assert.ok(!d.text.includes('lock noise'));
  assert.equal(d.files.length, 3);
});

test('prepareDiff: respects the byte budget, cutting one section and omitting the rest', () => {
  const big = `diff --git a/big.ts b/big.ts\n${'+x\n'.repeat(5000)}\ndiff --git a/other.ts b/other.ts\n+y`;
  const d = prepareDiff(big, { excludeGlobs: [], maxBytes: 4096 });
  assert.equal(d.truncated, true);
  assert.deepEqual(d.includedFiles, ['big.ts']);
  assert.deepEqual(d.omittedFiles, ['other.ts']);
  assert.ok(d.text.includes('size limit'));
  assert.ok(Buffer.byteLength(d.text) < 4096 + 200);
});

// --- prompt ---

test('buildPrompt: fences untrusted data in a nonce boundary and carries the schema', () => {
  const diff = prepareDiff(DIFF, { excludeGlobs: [], maxBytes: 100000 });
  const p = buildPrompt({ language: 'ts', checks: { lint: { jobResult: 'failure' } }, diff, maxFindings: 7, nonce: 'abc123' });
  assert.ok(p.system.includes('UNTRUSTED-abc123'));
  assert.ok(p.system.includes('At most 7 items'));
  assert.ok(p.system.includes('untrusted data'));
  assert.match(p.user, /<<<BEGIN UNTRUSTED-abc123[\s\S]*console\.log[\s\S]*<<<END UNTRUSTED-abc123/);
  assert.ok(!p.system.includes('console.log')); // diff content never lands in the system prompt
});

// --- reply parsing ---

test('extractJson: plain, fenced, and surrounded by prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":2}} hope it helps'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'), /no JSON object/);
});

test('validateReview: normalizes items, drops untitled ones, coerces bad severity', () => {
  const r = validateReview(good({ code: { assessment: 'x', items: [{ severity: 'catastrophic', title: 'Odd severity' }, { severity: 'high', detail: 'no title' }, 'junk'] } }), { maxFindings: 10 });
  assert.equal(r.sections.code.items.length, 1);
  assert.equal(r.sections.code.items[0].severity, 'info');
  assert.equal(r.sections.lint.items[0].line, 3);
});

test('validateReview: keeps the most severe items when over the cap', () => {
  const items = [
    { severity: 'low', title: 'l' },
    { severity: 'high', title: 'h' },
    { severity: 'medium', title: 'm' },
  ];
  const r = validateReview(good({ code: { assessment: '', items } }), { maxFindings: 2 });
  const kept = ['lint', 'tests', 'coverage', 'code'].flatMap((k) => r.sections[k].items.map((i) => i.title));
  assert.equal(kept.length, 2);
  assert.ok(kept.includes('h'));
  assert.ok(!kept.includes('l'));
});

test('validateReview: rejects a reply that is not a review', () => {
  assert.throws(() => validateReview({ summary: 'x' }, { maxFindings: 5 }), /sections/);
  assert.throws(() => validateReview([], { maxFindings: 5 }), /sections/);
});

// --- sanitizing and rendering ---

test('sanitize: escapes HTML, defuses @mentions, drops link and image targets', () => {
  assert.equal(sanitize('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.ok(!sanitize('ping @octocat now').includes('@octocat'));
  assert.equal(sanitize('see [docs](http://evil.example/?q=secret)'), 'see docs');
  assert.equal(sanitize('![x](http://evil.example/p.png?d=secret)'), 'x');
  assert.equal(sanitize('a[0] is fine'), 'a[0] is fine');
});

const checksFixture = (over = {}) => ({
  lint: { jobResult: 'failure', data: summarizeLint(SARIF, { workspace: '/w' }) },
  tests: { jobResult: 'success', data: summarizeTests(JEST.replace('"numFailedTests":1', '"numFailedTests":0'), 'jest-results.json') },
  coverage: { jobResult: 'success', data: summarizeCoverage(LCOV, 50, { changedFiles: ['src/a.ts'] }) },
  ...over,
});
const diffFixture = () => prepareDiff(DIFF, { excludeGlobs: ['package-lock.json'], maxBytes: 100000 });
const meta = { sha: 'abcdef1234567', model: 'gpt-x', provider: 'openai-compatible', repo: 'o/r', serverUrl: 'https://github.com' };

test('checkStatuses: derived from real outputs, including skipped and missing data', () => {
  const s = checkStatuses(checksFixture({
    tests: { jobResult: 'skipped', data: null },
    coverage: { jobResult: 'failure', data: null },
  }));
  assert.equal(s.lint.state, 'fail');
  assert.equal(s.tests.state, 'skipped');
  assert.equal(s.coverage.state, 'fail');
  assert.match(s.coverage.text, /no output available/);
  const pass = checkStatuses(checksFixture({ lint: { jobResult: 'success', data: { total: 0, errors: 0, warnings: 0, findings: [] } } }));
  assert.equal(pass.lint.state, 'pass');
  assert.equal(pass.coverage.state, 'pass'); // 62.5% >= 50%
});

test('verdict: a failing check or a high item means needs changes; clean means looks good', () => {
  const review = validateReview(good(), { maxFindings: 10 });
  const failing = verdict(checkStatuses(checksFixture()), review);
  assert.equal(failing.text, 'Needs changes');
  const clean = checksFixture({ lint: { jobResult: 'success', data: { total: 0, errors: 0, warnings: 0, findings: [] } } });
  const empty = validateReview(good({ lint: { assessment: '', items: [] } }), { maxFindings: 10 });
  assert.equal(verdict(checkStatuses(clean), empty).text, 'Looks good');
  const withHigh = validateReview(good({ code: { assessment: '', items: [{ severity: 'high', title: 'Bug' }] } }), { maxFindings: 10 });
  assert.equal(verdict(checkStatuses(clean), withHigh).text, 'Needs changes');
});

test('renderMarkdown: marker, status table, numbered sections, checkboxes, linked file refs', () => {
  const review = validateReview(good({ code: { assessment: 'Check this.', items: [{ severity: 'high', file: 'src/a.ts', line: 1, title: 'Null deref', detail: 'x may be null.', fix: 'Guard it.' }] } }), { maxFindings: 10 });
  const md = renderMarkdown({ review, checks: checksFixture(), diff: diffFixture(), meta });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /\| Lint \| ❌ \|/);
  assert.match(md, /\| Unit tests \| ✅ \|/);
  assert.match(md, /### 1\. Lint/);
  assert.match(md, /### 4\. Code review/);
  assert.match(md, /- \[ \] 🔴 \*\*High\*\* · \[`src\/a\.ts:1`\]\(https:\/\/github\.com\/o\/r\/blob\/abcdef1234567\/src\/a\.ts#L1\) — Null deref/);
  assert.match(md, /💡 \*\*Fix:\*\* Guard it\./);
  assert.match(md, /Nothing to flag/); // the tests section has no items
  assert.match(md, /Commit `abcdef1`/);
  assert.match(md, /Lowest-covered files changed in this PR|Lowest-covered files/);
  assert.match(md, /Verdict: ❌ Needs changes/);
});

test('renderMarkdown: a file the diff does not contain is not linked (no fabricated references)', () => {
  const review = validateReview(good({ code: { assessment: '', items: [{ severity: 'low', file: 'src/ghost.ts', line: 4, title: 'Made up' }] } }), { maxFindings: 10 });
  const md = renderMarkdown({ review, checks: checksFixture(), diff: diffFixture(), meta });
  assert.ok(!md.includes('ghost.ts'));
  assert.ok(md.includes('Made up'));
});

test('renderMarkdown: model text cannot inject HTML, mentions or links', () => {
  const review = validateReview(good({ code: { assessment: '<script>alert(1)</script>', items: [{ severity: 'low', title: 'cc @everyone [click](http://evil.example)', detail: '<b>x</b>' }] } }), { maxFindings: 10 });
  const md = renderMarkdown({ review, checks: checksFixture(), diff: diffFixture(), meta });
  assert.ok(!md.includes('<script>'));
  assert.ok(!md.includes('<b>'));
  assert.ok(!md.includes('@everyone'));
  assert.ok(!md.includes('evil.example'));
});

test('renderMarkdown: states missing check output and truncation honestly', () => {
  const diff = prepareDiff(`diff --git a/big.ts b/big.ts\n${'+x\n'.repeat(5000)}\ndiff --git a/o.ts b/o.ts\n+y`, { excludeGlobs: [], maxBytes: 4096 });
  const md = renderMarkdown({
    review: validateReview(good(), { maxFindings: 5 }),
    checks: checksFixture({ coverage: { jobResult: 'failure', data: null } }),
    diff,
    meta,
  });
  assert.match(md, /no output available \(job result: failure\)/);
  assert.match(md, /omitted \/ cut for size/);
});

test('renderMarkdown: stays under the GitHub comment limit', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ severity: 'low', title: `t${i}`, detail: 'd'.repeat(1200), fix: 'f'.repeat(800) }));
  const review = validateReview(good({ code: { assessment: '', items } }), { maxFindings: 40 });
  assert.ok(renderMarkdown({ review, checks: checksFixture(), diff: diffFixture(), meta }).length < 65000);
});

// --- posting ---

function fakeGithub(existing = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (init.method === 'GET') return reply(200, existing);
    if (init.method === 'PATCH') return reply(200, { id: 99 });
    return reply(201, { id: 555 });
  };
  return { fetchImpl, calls };
}

test('postComment: creates a comment when none carries the marker', async () => {
  const { fetchImpl, calls } = fakeGithub([{ id: 1, body: 'hello', user: { login: 'someone' } }]);
  const r = await postComment(`${MARKER}\nbody`, { repo: 'o/r', prNumber: '5', token: 't', fetchImpl });
  assert.deepEqual(r, { action: 'created', id: 555 });
  assert.equal(calls.at(-1).method, 'POST');
  assert.ok(calls.at(-1).url.endsWith('/repos/o/r/issues/5/comments'));
});

test('postComment: updates the bot\'s own marked comment in place', async () => {
  const { fetchImpl, calls } = fakeGithub([{ id: 99, body: `${MARKER} old`, user: { login: 'github-actions[bot]' } }]);
  const r = await postComment(`${MARKER}\nnew`, { repo: 'o/r', prNumber: '5', token: 't', fetchImpl });
  assert.deepEqual(r, { action: 'updated', id: 99 });
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.ok(calls.at(-1).url.endsWith('/issues/comments/99'));
});

test('postComment: never edits a human\'s comment that merely quotes the marker', async () => {
  const { fetchImpl, calls } = fakeGithub([{ id: 7, body: `${MARKER} quoted`, user: { login: 'human' } }]);
  const r = await postComment(`${MARKER}\nnew`, { repo: 'o/r', prNumber: '5', token: 't', fetchImpl });
  assert.equal(r.action, 'created');
  assert.equal(calls.at(-1).method, 'POST');
});

test('postComment: an API failure throws a message without the token', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'Resource not accessible by integration t0ken' });
  await assert.rejects(postComment('x', { repo: 'o/r', prNumber: '5', token: 't0ken', fetchImpl }), (e) => /HTTP 403/.test(e.message) && !e.message.includes('t0ken'));
});

for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL: ${name}`);
    console.log(`  ${err.message}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} tests passed`);
