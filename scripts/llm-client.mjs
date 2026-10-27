// scripts/llm-client.mjs
//
// Provider-agnostic LLM client used by scripts/llm-review.mjs (and through it
// by .github/actions/llm-review/action.yml). Zero dependencies: it uses the
// global `fetch` that ships with Node 20+. Unit-tested in
// tests/test_llm-client.mjs with an injected fake `fetch`.
//
// "Compatible with every model" is delivered through three wire formats, not
// one per vendor:
//   openai-compatible  POST {base}/chat/completions, `Authorization: Bearer`.
//                      OpenAI, Gemini's OpenAI-compatibility endpoint, Groq,
//                      OpenRouter, Mistral, DeepSeek, Together, vLLM, Ollama,
//                      LiteLLM and most gateways speak this.
//   anthropic          POST {base}/v1/messages, `x-api-key`.
//   gemini             POST {base}/v1beta/models/{model}:generateContent,
//                      `x-goog-api-key` (Google's native API).
//
// The request body is deliberately minimal — model + messages only, no
// temperature, no response_format, no max-token field (except Anthropic, which
// requires one). Newer models reject sampling and token-limit parameters their
// own family doesn't support, so every optional parameter is a compatibility
// risk. The reply format (JSON) is requested in the prompt, not the API.
//
// The API token travels only in a request header — never in a URL, a log line
// or an error message (every message is scrubbed of the token before it
// leaves this module).

export const PROVIDERS = ['openai-compatible', 'anthropic', 'gemini'];

export const DEFAULT_BASE_URLS = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

const ANTHROPIC_VERSION = '2023-06-01';

// LlmError carries enough to decide whether to retry and how to word the
// failure: `kind` is one of auth | rate_limit | server | client | network |
// timeout | response.
export class LlmError extends Error {
  constructor(message, { kind = 'client', retryable = false, status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// scrub(text, token) -> text with every occurrence of the token masked, so a
// provider that echoes the key back in an error body can't leak it to logs.
export function scrub(text, token) {
  const s = String(text ?? '');
  return token ? s.split(token).join('***') : s;
}

// resolveConfig({provider, baseUrl, model, token}) -> a validated config.
// Throws a plain Error naming exactly what to fix.
export function resolveConfig({ provider, baseUrl, model, token }) {
  const p = (provider ?? '').trim();
  if (!PROVIDERS.includes(p)) {
    throw new Error(`unsupported llm_provider '${p}'. Supported values: ${PROVIDERS.join(' ')}`);
  }
  const m = (model ?? '').trim().replace(/^models\//, ''); // gemini lists models as "models/<name>"
  if (!m) {
    throw new Error("llm_model is empty. Set the llm_model input to the model name your provider expects (for example gpt-4o, gemini-2.5-flash or claude-sonnet-4-5). No default is chosen for you because model names differ per provider and change often.");
  }
  const base = ((baseUrl ?? '').trim() || DEFAULT_BASE_URLS[p]).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`llm_base_url '${base}' is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    // The token is sent to this URL: refuse to send it in clear text.
    throw new Error(`llm_base_url '${base}' must use https:// (the API token is sent to it)`);
  }
  return { provider: p, baseUrl: base, model: m, token: (token ?? '').trim() };
}

function authHeaders(config) {
  switch (config.provider) {
    case 'anthropic':
      return { 'x-api-key': config.token, 'anthropic-version': ANTHROPIC_VERSION };
    case 'gemini':
      return { 'x-goog-api-key': config.token };
    default: // openai-compatible
      return { authorization: `Bearer ${config.token}` };
  }
}

// buildRequest(config, {system, user, maxOutputTokens}) -> {url, headers, body}
export function buildRequest(config, { system, user, maxOutputTokens = 4096 }) {
  const headers = { 'content-type': 'application/json', ...authHeaders(config) };
  switch (config.provider) {
    case 'anthropic':
      return {
        url: `${config.baseUrl}/v1/messages`,
        headers,
        // max_tokens is mandatory on this API, unlike the other two.
        body: { model: config.model, max_tokens: maxOutputTokens, system, messages: [{ role: 'user', content: user }] },
      };
    case 'gemini':
      return {
        url: `${config.baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
        headers,
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
        },
      };
    default:
      return {
        url: `${config.baseUrl}/chat/completions`,
        headers,
        body: { model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
      };
  }
}

// extractText(provider, json) -> the model's reply text, or an LlmError.
export function extractText(provider, json) {
  let text = '';
  let truncated = false;
  if (provider === 'anthropic') {
    text = (json?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
    truncated = json?.stop_reason === 'max_tokens';
  } else if (provider === 'gemini') {
    const block = json?.promptFeedback?.blockReason;
    if (block) {
      throw new LlmError(`the provider blocked the prompt (blockReason: ${block}). The diff may contain content its safety filter rejects.`, { kind: 'response' });
    }
    const cand = json?.candidates?.[0];
    // Skip "thought" parts that thinking models may return alongside the answer.
    text = (cand?.content?.parts ?? []).filter((p) => !p?.thought).map((p) => p?.text ?? '').join('');
    truncated = cand?.finishReason === 'MAX_TOKENS';
  } else {
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    text = Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : (content ?? '');
    truncated = choice?.finish_reason === 'length';
    if (!text && choice?.message?.refusal) {
      throw new LlmError(`the model refused the request: ${String(choice.message.refusal).slice(0, 200)}`, { kind: 'response' });
    }
  }
  if (!text.trim()) {
    throw new LlmError(
      truncated
        ? 'the model hit its output limit before producing any text. Raise llm_max_output_tokens or use a model with a larger output limit.'
        : 'the provider returned an empty reply (no text in the response).',
      { kind: 'response' },
    );
  }
  return text;
}

// providerMessage(bodyText) -> the human message inside a provider error body.
function providerMessage(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const e = j?.error ?? (Array.isArray(j) ? j[0]?.error : null);
    const msg = typeof e === 'string' ? e : (e?.message ?? j?.message);
    if (msg) return String(msg);
  } catch {
    // not JSON: fall through to the raw text
  }
  return bodyText;
}

function looksLikeInvalidKey(status, message) {
  // Gemini answers a bad key with HTTP 400 "API key not valid" (API_KEY_INVALID)
  // rather than 401.
  return status === 400 && /api[_ ]key (not valid|invalid)|API_KEY_INVALID/i.test(message);
}

// classifyHttpError(status, bodyText, config, retryAfterHeader) -> LlmError
export function classifyHttpError(status, bodyText, config, retryAfterHeader = null) {
  const message = scrub(providerMessage(bodyText), config.token).replace(/\s+/g, ' ').trim().slice(0, 300);
  const prefix = `provider returned HTTP ${status}${message ? `: ${message}` : ''}`;
  if (status === 401 || looksLikeInvalidKey(status, message)) {
    return new LlmError(`${prefix}. The AI_TOKEN secret was rejected — check it is a valid key for provider '${config.provider}' (base URL ${config.baseUrl}).`, { kind: 'auth', status });
  }
  if (status === 403) {
    return new LlmError(`${prefix}. The key is valid but not allowed to call model '${config.model}' (permissions, region or billing).`, { kind: 'auth', status });
  }
  if (status === 404) {
    return new LlmError(`${prefix}. Check llm_model ('${config.model}') and llm_base_url ('${config.baseUrl}').`, { kind: 'client', status });
  }
  if (status === 429) {
    const seconds = Number(retryAfterHeader);
    return new LlmError(`${prefix}. Rate limited or out of quota.`, {
      kind: 'rate_limit',
      retryable: true,
      status,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    });
  }
  if (status >= 500) {
    return new LlmError(`${prefix}. Provider-side error.`, { kind: 'server', retryable: true, status });
  }
  return new LlmError(prefix, { kind: 'client', status });
}

function toNetworkError(e, config, timeoutMs) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new LlmError(`request to ${config.baseUrl} timed out after ${Math.round(timeoutMs / 1000)}s. Raise llm_timeout_seconds or use a faster model.`, { kind: 'timeout', retryable: true });
  }
  const cause = e?.cause?.code ? ` (${e.cause.code})` : '';
  return new LlmError(`could not reach ${config.baseUrl}: ${scrub(e?.message, config.token)}${cause}`, { kind: 'network', retryable: true });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// callModel(config, {system, user}, opts) -> reply text.
// Retries 429 / 5xx / network / timeout up to `maxAttempts` with exponential
// backoff (honoring Retry-After, capped); auth and request errors fail at once.
export async function callModel(config, prompt, opts = {}) {
  const {
    timeoutMs = 120000,
    maxAttempts = 3,
    baseDelayMs = 2000,
    maxDelayMs = 30000,
    maxOutputTokens = 4096,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
  } = opts;
  const req = buildRequest(config, { ...prompt, maxOutputTokens });
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bodyText = await res.text();
      if (!res.ok) {
        throw classifyHttpError(res.status, bodyText, config, res.headers?.get?.('retry-after'));
      }
      let json;
      try {
        json = JSON.parse(bodyText);
      } catch {
        throw new LlmError('the provider returned a non-JSON response body', { kind: 'response' });
      }
      return extractText(config.provider, json);
    } catch (e) {
      lastError = e instanceof LlmError ? e : toNetworkError(e, config, timeoutMs);
      if (!lastError.retryable || attempt === maxAttempts) break;
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(Math.min(lastError.retryAfterMs ?? backoff, maxDelayMs));
    }
  }
  throw lastError;
}

// checkToken(config, opts) -> {status, detail}
//   status 'ok'         the provider accepted the key
//   status 'rejected'   the provider says the key is invalid (HTTP 401, or the
//                       Gemini "API key not valid" 400)
//   status 'unverified' the key could not be checked (no list endpoint, 403
//                       from a key restricted to inference, rate limit,
//                       outage, network) — the review call is the real test
// Uses the cheap, free "list models" endpoint, so no tokens are spent.
export async function checkToken(config, { timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
  let url;
  if (config.provider === 'anthropic') url = `${config.baseUrl}/v1/models?limit=1`;
  else if (config.provider === 'gemini') url = `${config.baseUrl}/v1beta/models?pageSize=1`;
  else url = `${config.baseUrl}/models`;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: authHeaders(config),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { status: 'ok', detail: '' };
    const err = classifyHttpError(res.status, await res.text(), config);
    if (err.kind === 'auth' && res.status === 401) return { status: 'rejected', detail: err.message };
    if (looksLikeInvalidKey(res.status, err.message)) return { status: 'rejected', detail: err.message };
    return { status: 'unverified', detail: `the models endpoint answered HTTP ${res.status}, so the key could not be pre-verified; the review call will confirm it` };
  } catch (e) {
    return { status: 'unverified', detail: toNetworkError(e, config, timeoutMs).message };
  }
}
