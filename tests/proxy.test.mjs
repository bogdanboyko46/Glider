// node tests/proxy.test.mjs — the simplify proxy's request handling (proxy/lib/core.js) with a fake Anthropic client.
import { handle, createLimiter, SYSTEM, MODEL_DEFAULT } from '../proxy/lib/core.js';

let failed = 0;
const ok = (c, label, detail = '') => { if (c) console.log('ok  ', label); else { failed += 1; console.error('FAIL', label, detail); } };

class APIError extends Error { constructor(status) { super('api'); this.status = status; } }
class AuthenticationError extends APIError {}
class RateLimitError extends APIError {}
class APIConnectionError extends APIError {}
const errors = { APIError, AuthenticationError, RateLimitError, APIConnectionError };

const TEXT = 'The enzyme responsible for the first step is probably the most abundant protein on Earth, and it is famously slow.';
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const calls = [];
const good = async (params) => { calls.push(params); return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' One enzyme starts it.\nIt is very common. ' }] }; };
const req = (over = {}) => ({ method: 'POST', headers: { origin: EXT, 'x-glider-install': 'install-0001', ...(over.headers || {}) }, body: { text: TEXT }, ip: '1.2.3.4', ...over, ...(over.headers ? { headers: { origin: EXT, 'x-glider-install': 'install-0001', ...over.headers } } : {}) });
const run = (r, deps = {}) => handle(r, { create: good, errors, env: {}, ...deps });

// ---- the happy path
{
  const out = await run(req({ body: { text: TEXT, lineText: 'the most abundant protein' } }));
  ok(out.status === 200 && out.body.ok && out.body.text === 'One enzyme starts it. It is very common.', 'rewrites and returns clean one-paragraph text', JSON.stringify(out.body));
  const p = calls.at(-1);
  ok(p.model === MODEL_DEFAULT && p.system === SYSTEM && p.max_tokens === 16000 && p.output_config.effort === 'low', 'request uses the default model, the system prompt and low effort');
  ok(p.fallbacks === 'default' && p.betas.includes('server-side-fallback-2026-07-01'), 'refusal fallbacks are on');
  ok(p.messages.length === 1 && p.messages[0].content.includes('<passage>\n' + TEXT + '\n</passage>') && p.messages[0].content.includes('<hard_part>\nthe most abundant protein'), 'passage and hard part are wrapped as data');
  ok(!('temperature' in p) && !('thinking' in p), 'no sampling or thinking parameters are sent');
  ok(out.headers['access-control-allow-origin'] === EXT && out.headers['cache-control'] === 'no-store', 'CORS answers the calling extension only; nothing is cached');
  ok(!JSON.stringify(out).includes('sk-ant'), 'no key material in the response');
}
ok((await run(req(), { env: { GLIDER_MODEL: 'claude-haiku-5-5' } })) && calls.at(-1).model === 'claude-haiku-5-5', 'GLIDER_MODEL overrides the model');
ok((await run(req({ body: JSON.stringify({ text: TEXT }) }))).body.ok, 'a JSON string body is accepted');

// ---- who may call
ok((await run(req({ method: 'OPTIONS' }))).status === 204, 'OPTIONS preflight answers 204');
ok((await run(req({ method: 'GET' }))).status === 405, 'GET is refused');
for (const origin of ['', 'https://evil.example', 'null']) ok((await run(req({ headers: { origin } }))).status === 403, `origin "${origin}" is refused`);
ok((await run(req(), { env: { GLIDER_EXTENSION_IDS: 'someotherid, another' } })).status === 403, 'an extension id outside GLIDER_EXTENSION_IDS is refused');
ok((await run(req(), { env: { GLIDER_EXTENSION_IDS: 'x abcdefghijklmnopabcdefghijklmnop' } })).status === 200, 'a listed extension id is accepted');
ok((await run(req(), { env: { GLIDER_PROXY_TOKEN: 's3cret' } })).status === 401, 'a missing access code is refused when one is required');
ok((await run(req({ headers: { 'x-glider-token': 'nope' } }), { env: { GLIDER_PROXY_TOKEN: 's3cret' } })).status === 401, 'a wrong access code is refused');
ok((await run(req({ headers: { 'x-glider-token': 's3cret' } }), { env: { GLIDER_PROXY_TOKEN: 's3cret' } })).status === 200, 'the right access code is accepted');

// ---- what may be sent
const before = calls.length;
for (const [label, body] of [['no body', null], ['not JSON', '{oops'], ['no text', {}], ['text not a string', { text: 42 }], ['too short', { text: 'Hi there.' }], ['too long', { text: 'word '.repeat(1300) }]]) {
  const out = await run(req({ body }));
  ok(out.status === 400 && out.body.reason === 'bad-request', `bad input (${label}) is refused`);
}
ok(calls.length === before, 'bad input never reaches Anthropic');

// ---- rate limiting
{
  let t = 0;
  const limiter = createLimiter({ perKey: 3, keyWindowMs: 1000, global: 5, globalWindowMs: 5000, now: () => t });
  const hit = (install) => run(req({ headers: { 'x-glider-install': install } }), { limiter });
  const first = [await hit('install-aaaa'), await hit('install-aaaa'), await hit('install-aaaa')];
  ok(first.every((o) => o.status === 200), 'requests under the limit pass');
  const over = await hit('install-aaaa');
  ok(over.status === 429 && over.body.reason === 'rate-limited' && Number(over.headers['retry-after']) >= 1, 'the fourth request from one install is limited, with retry-after');
  ok((await hit('install-bbbb')).status === 200, 'another install is not affected');
  t = 1500;
  ok((await hit('install-aaaa')).status === 200, 'the limit lifts after the window');
  ok((await hit('install-cccc')).status === 429, 'the global cap stops everyone');
  t = 10000;
  ok((await run(req({ headers: { 'x-glider-install': '' }, ip: '9.9.9.9' }), { limiter })).status === 200, 'without an install id the IP address is the key');
}

// ---- when Anthropic misbehaves
const failing = (e) => ({ create: async () => { throw e; } });
ok((await run(req(), failing(new AuthenticationError(401)))).body.reason === 'server-key', 'a bad server key is reported as server-key (502)');
ok((await run(req(), failing(new RateLimitError(429)))).status === 429, 'an Anthropic rate limit becomes 429');
ok((await run(req(), failing(new APIConnectionError()))).body.reason === 'network', 'a connection failure is reported as network');
ok((await run(req(), failing(new APIError(529)))).body.reason === 'upstream', 'other API errors are reported as upstream');
{
  const out = await run(req(), failing(new Error('boom sk-ant-secret')));
  ok(out.status === 500 && out.body.reason === 'error' && !JSON.stringify(out).includes('boom'), 'unexpected errors answer 500 without leaking the message');
}
const answer = (m) => ({ create: async () => m });
ok((await run(req(), answer({ stop_reason: 'refusal', content: [] }))).body.reason === 'declined', 'a refusal is reported as declined');
ok((await run(req(), answer({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Half a' }] }))).body.reason === 'cut-off', 'a truncated answer is not used');
ok((await run(req(), answer({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'x' }] }))).body.reason === 'bad-response', 'an answer with no text is not used');
ok((await run(req(), answer({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'blah '.repeat(200) }] }))).body.reason === 'bad-response', 'an answer far longer than the passage is not used');

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall proxy tests passed');
