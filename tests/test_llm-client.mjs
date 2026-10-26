#!/usr/bin/env node
// tests/test_llm-client.mjs
//
// Unit tests for scripts/llm-client.mjs, using an injected fake `fetch`.
// Run directly:
//   node tests/test_llm-client.mjs

import assert from 'node:assert/strict';
import {
  PROVIDERS,
  LlmError,
  resolveConfig,
  buildRequest,
  extractText,
  classifyHttpError,
  callModel,
  checkToken,
  scrub,
} from '../scripts/llm-client.mjs';

let failures = 0;
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

const TOKEN = 'sk-secret-123';
const base = { model: 'm1', token: TOKEN };
const openai = resolveConfig({ ...base, provider: 'openai-compatible' });
const anthropic = resolveConfig({ ...base, provider: 'anthropic' });
const gemini = resolveConfig({ ...base, provider: 'gemini' });

// fakeResponse(status, body, headers) -> a minimal fetch Response
function fakeResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => text,
  };
}

// scripted(...responses) -> {fetchImpl, calls}; a Response is returned, an Error thrown.
function scripted(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

// --- resolveConfig ---

test('resolveConfig: defaults base URL per provider and strips a trailing slash', () => {
  assert.equal(openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(anthropic.baseUrl, 'https://api.anthropic.com');
  assert.equal(gemini.baseUrl, 'https://generativelanguage.googleapis.com');
  const c = resolveConfig({ ...base, provider: 'openai-compatible', baseUrl: 'https://x.example/v1/' });
  assert.equal(c.baseUrl, 'https://x.example/v1');
});

test('resolveConfig: unsupported provider lists the supported values', () => {
  assert.throws(() => resolveConfig({ ...base, provider: 'cohere' }), (e) => PROVIDERS.every((p) => e.message.includes(p)));
});

test('resolveConfig: an empty model is an error and models/ prefix is stripped', () => {
  assert.throws(() => resolveConfig({ provider: 'gemini', model: '  ', token: 't' }), /llm_model is empty/);
  assert.equal(resolveConfig({ provider: 'gemini', model: 'models/gemini-2.5-flash', token: 't' }).model, 'gemini-2.5-flash');
});

test('resolveConfig: refuses a plain-http base URL except for localhost', () => {
  assert.throws(() => resolveConfig({ ...base, provider: 'openai-compatible', baseUrl: 'http://evil.example/v1' }), /https/);
  assert.doesNotThrow(() => resolveConfig({ ...base, provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }));
  assert.throws(() => resolveConfig({ ...base, provider: 'openai-compatible', baseUrl: 'not a url' }), /not a valid URL/);
});

// --- buildRequest ---

test('buildRequest: openai-compatible sends Bearer auth, chat/completions and no optional params', () => {
  const r = buildRequest(openai, { system: 'S', user: 'U' });
  assert.equal(r.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(Object.keys(r.body).sort(), ['messages', 'model']);
  assert.deepEqual(r.body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
});

test('buildRequest: anthropic uses x-api-key, system field and a max_tokens', () => {
  const r = buildRequest(anthropic, { system: 'S', user: 'U', maxOutputTokens: 777 });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], TOKEN);
  assert.ok(r.headers['anthropic-version']);
  assert.equal(r.body.max_tokens, 777);
  assert.equal(r.body.system, 'S');
});

test('buildRequest: gemini puts the key in a header, never in the URL', () => {
  const r = buildRequest(gemini, { system: 'S', user: 'U' });
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent');
  assert.equal(r.headers['x-goog-api-key'], TOKEN);
  assert.ok(!r.url.includes(TOKEN));
  assert.equal(r.body.systemInstruction.parts[0].text, 'S');
  assert.equal(r.body.contents[0].parts[0].text, 'U');
});

// --- extractText ---

test('extractText: reads each provider shape', () => {
  assert.equal(extractText('openai-compatible', { choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.equal(extractText('openai-compatible', { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
  assert.equal(extractText('anthropic', { content: [{ type: 'text', text: 'hi' }] }), 'hi');
  assert.equal(extractText('gemini', { candidates: [{ content: { parts: [{ text: 'hi' }] } }] }), 'hi');
});

test('extractText: gemini skips thought parts', () => {
  const json = { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: 'answer' }] } }] };
  assert.equal(extractText('gemini', json), 'answer');
});

test('extractText: empty replies fail clearly, naming truncation when that is the cause', () => {
  assert.throws(() => extractText('openai-compatible', { choices: [{ message: { content: '' }, finish_reason: 'length' }] }), /output limit/);
  assert.throws(() => extractText('anthropic', { content: [] }), /empty reply/);
  assert.throws(() => extractText('gemini', { promptFeedback: { blockReason: 'SAFETY' } }), /blocked the prompt/);
  assert.throws(() => extractText('openai-compatible', { choices: [{ message: { content: null, refusal: 'no' } }] }), /refused/);
});

// --- classifyHttpError ---

test('classifyHttpError: maps statuses to kinds and retryability', () => {
  const e401 = classifyHttpError(401, '{"error":{"message":"bad key"}}', openai);
  assert.equal(e401.kind, 'auth');
  assert.equal(e401.retryable, false);
  assert.match(e401.message, /AI_TOKEN secret was rejected/);
  assert.equal(classifyHttpError(403, '{}', openai).kind, 'auth');
  assert.equal(classifyHttpError(404, '{}', openai).kind, 'client');
  const e429 = classifyHttpError(429, '{}', openai, '7');
  assert.equal(e429.retryable, true);
  assert.equal(e429.retryAfterMs, 7000);
  assert.equal(classifyHttpError(503, 'down', openai).retryable, true);
  assert.equal(classifyHttpError(400, '{}', openai).retryable, false);
});

test('classifyHttpError: gemini invalid key arrives as 400 but is an auth error', () => {
  const e = classifyHttpError(400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}', gemini);
  assert.equal(e.kind, 'auth');
});

test('classifyHttpError: never leaks the token a provider echoes back', () => {
  const e = classifyHttpError(401, `{"error":{"message":"Incorrect API key provided: ${TOKEN}"}}`, openai);
  assert.ok(!e.message.includes(TOKEN));
  assert.equal(scrub(`a ${TOKEN} b`, TOKEN), 'a *** b');
});

// --- callModel ---

test('callModel: returns the reply on success and sends the request once', async () => {
  const { fetchImpl, calls } = scripted(fakeResponse(200, { choices: [{ message: { content: 'ok' } }] }));
  const out = await callModel(openai, { system: 'S', user: 'U' }, { fetchImpl, sleep: noSleep });
  assert.equal(out, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).model, 'm1');
});

test('callModel: retries a 429 then succeeds, honoring Retry-After', async () => {
  const waits = [];
  const { fetchImpl, calls } = scripted(
    fakeResponse(429, '{}', { 'retry-after': '3' }),
    fakeResponse(200, { choices: [{ message: { content: 'ok' } }] }),
  );
  const out = await callModel(openai, { system: 'S', user: 'U' }, { fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.equal(out, 'ok');
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [3000]);
});

test('callModel: does not retry an auth failure', async () => {
  const { fetchImpl, calls } = scripted(fakeResponse(401, '{"error":{"message":"nope"}}'));
  await assert.rejects(callModel(openai, { system: 'S', user: 'U' }, { fetchImpl, sleep: noSleep }), (e) => e instanceof LlmError && e.kind === 'auth');
  assert.equal(calls.length, 1);
});

test('callModel: gives up after maxAttempts on persistent 5xx', async () => {
  const { fetchImpl, calls } = scripted(fakeResponse(503, 'unavailable'));
  await assert.rejects(callModel(openai, { system: 'S', user: 'U' }, { fetchImpl, sleep: noSleep, maxAttempts: 3 }), (e) => e.kind === 'server');
  assert.equal(calls.length, 3);
});

test('callModel: a network error is retried and reported without the token', async () => {
  const boom = new Error(`connect failed for ${TOKEN}`);
  const { fetchImpl, calls } = scripted(boom);
  await assert.rejects(callModel(openai, { system: 'S', user: 'U' }, { fetchImpl, sleep: noSleep, maxAttempts: 2 }), (e) => e.kind === 'network' && !e.message.includes(TOKEN));
  assert.equal(calls.length, 2);
});

test('callModel: a timeout is reported as such', async () => {
  const err = new Error('aborted');
  err.name = 'TimeoutError';
  const { fetchImpl } = scripted(err);
  await assert.rejects(callModel(openai, { system: 'S', user: 'U' }, { fetchImpl, sleep: noSleep, maxAttempts: 1, timeoutMs: 5000 }), (e) => e.kind === 'timeout' && /5s/.test(e.message));
});

test('callModel: a non-JSON success body is a clear response error', async () => {
  const { fetchImpl } = scripted(fakeResponse(200, '<html>gateway</html>'));
  await assert.rejects(callModel(openai, { system: 'S', user: 'U' }, { fetchImpl, sleep: noSleep }), /non-JSON/);
});

// --- checkToken ---

test('checkToken: 200 is ok; each provider hits its own free list endpoint', async () => {
  for (const [config, expected] of [
    [openai, 'https://api.openai.com/v1/models'],
    [anthropic, 'https://api.anthropic.com/v1/models?limit=1'],
    [gemini, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1'],
  ]) {
    const { fetchImpl, calls } = scripted(fakeResponse(200, { data: [] }));
    assert.deepEqual(await checkToken(config, { fetchImpl }), { status: 'ok', detail: '' });
    assert.equal(calls[0].url, expected);
    assert.equal(calls[0].init.method, 'GET');
  }
});

test('checkToken: 401 and the gemini invalid-key 400 are rejected', async () => {
  const r1 = await checkToken(openai, { fetchImpl: scripted(fakeResponse(401, '{"error":{"message":"bad"}}')).fetchImpl });
  assert.equal(r1.status, 'rejected');
  const r2 = await checkToken(gemini, { fetchImpl: scripted(fakeResponse(400, '{"error":{"message":"API key not valid."}}')).fetchImpl });
  assert.equal(r2.status, 'rejected');
});

test('checkToken: 403, 404, 429 and network errors are unverified, not rejected', async () => {
  for (const status of [403, 404, 429, 500]) {
    const r = await checkToken(openai, { fetchImpl: scripted(fakeResponse(status, '{}')).fetchImpl });
    assert.equal(r.status, 'unverified', `status ${status}`);
  }
  const r = await checkToken(openai, { fetchImpl: scripted(new Error('ECONNRESET')).fetchImpl });
  assert.equal(r.status, 'unverified');
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
