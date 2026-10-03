// The Groq client against the local mock (dev/mock-openai.ts on 8899, Groq under /groq/openai/v1).
import assert from 'node:assert/strict';
import { llmConfig, makeClient, parseDuration, parseJsonLoose } from '../team-console/src/llm';
import { UNDERSTAND_SCHEMA, understandPrompt } from '../team-console/src/prompts';

const BASE = 'http://127.0.0.1:8899/groq/openai/v1';
const ctl = async (b: unknown) => (await fetch('http://127.0.0.1:8899/__control', { method: 'POST', body: JSON.stringify(b) })).json();
const env = (extra: Record<string, string> = {}) => ({ GROQ_API_KEY: 'gsk_test', GROQ_BASE_URL: BASE, ...extra });
const ping = { name: 'ping', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }, system: 'Reply with JSON.', user: 'Return {"ok": true}.', maxTokens: 400 };
const understand = () => {
  const p = understandPrompt({ caption: 'زيت زيتون', postProducts: ['Olive Oil Extra Virgin (زيت زيتون بكر ممتاز)'], name: 'سارة', comment: 'وين بلاقيه بخلدا؟', productHints: ['Olive Oil Extra Virgin (زيت زيتون بكر ممتاز)'], placeHints: ['Khalda (خلدا)'] });
  return { name: 'understand_comment', schema: UNDERSTAND_SCHEMA as unknown as Record<string, unknown>, system: p.system, user: p.user, images: ['data:image/png;base64,iVBORw0KGgo='], maxTokens: 2500 };
};

// durations as Groq writes them
assert.equal(parseDuration('7.66s'), 7660);
assert.equal(parseDuration('2m59.56s'), 179560);
assert.equal(parseDuration('1h2m3s'), 3723000);
assert.equal(parseDuration('500ms'), 500);
assert.equal(parseDuration('soon'), null);
assert.deepEqual(parseJsonLoose('<think>let me see {x}</think>\n{"ok":true}'), { ok: true });

await ctl({ reset: true, groq: { tpm: 8000, windowMs: 60000, dailyCapped: false, failedGeneration: 0, noStrict: false, noRetryHeader: false, latencyMs: 20 } });

// 1. gpt-oss-120b: strict schema, reasoning_effort low, output capped at 1000, the image dropped (text-only model)
const c = makeClient(llmConfig(env())!);
assert.equal(c.vision, false);
let r = await c.chatJSON<any>(understand());
assert.equal(r.data.intent, 'availability');
assert.equal(r.model, 'openai/gpt-oss-120b');
let st = (await ctl({})).stats;
assert.equal(st.groq_understand_comment, 1);
assert.equal(st.groq_max_tokens_seen, 1000, 'max_completion_tokens capped for the free tier');
assert.equal(st.groq_reasoning, 'low');
assert.equal(st.groq_images_rejected, undefined, 'no image sent to a text-only model');
console.log('gpt-oss-120b: strict JSON, reasoning low, 1000-token cap, caption only ✓');

// 2. a model without strict JSON Schema support: falls back to JSON mode, remembers it
await ctl({ reset: true });
const llama = makeClient(llmConfig(env({ GROQ_MODEL: 'llama-3.3-70b-versatile' }))!);
r = await llama.chatJSON<any>(understand());
assert.equal(r.data.language, 'ar');
r = await llama.chatJSON<any>(ping);
assert.equal(r.data.ok, true);
st = (await ctl({})).stats;
assert.equal(st.groq_rejected_schema, 1, 'json_schema rejected once, then remembered');
assert.equal(st.groq_json_object, 2);
console.log('llama-3.3-70b: json_schema rejected once → JSON mode, remembered ✓');

// 3. JSON mode rejected an answer wrapped in text: the failed_generation text is used
await ctl({ reset: true, groq: { failedGeneration: 1 } });
r = await c.chatJSON<any>(ping);
assert.equal(r.data.ok, true);
assert.equal((await ctl({})).stats.groq_failed_generation, 1);
console.log('json_validate_failed: answer recovered from failed_generation ✓');

// 4. rate limit, per minute: a patient client waits as asked; a quick one gives up fast with a clear message
await ctl({ reset: true, groq: { tpm: 1000, windowMs: 3000 } }); // 1000 tokens per 3 s; a ping costs ~440 (prompt + its 400-token cap)
const patient = makeClient(llmConfig(env())!, { patient: true, onWait: (ms) => waits.push(ms) });
const waits: number[] = [];
let t0 = Date.now();
const results = await Promise.all([1, 2, 3].map(() => patient.chatJSON<any>(ping)));
assert.ok(results.every((x) => x.data.ok === true));
st = (await ctl({})).stats;
assert.ok(st.groq_429 >= 1 && waits.length >= 1, `expected waits on 429 (got ${st.groq_429} 429s, ${waits.length} waits)`);
console.log(`patient: 3 calls through a 1000-token bucket in ${Date.now() - t0} ms, ${st.groq_429} × 429 waited out ✓`);
await ctl({ groq: { tpm: 600, windowMs: 120000, refill: true } }); // slow refill: the wait asked is longer than 10 s
const quick = makeClient(llmConfig(env())!);
await quick.chatJSON<any>(ping); // takes most of the bucket
t0 = Date.now();
await assert.rejects(quick.chatJSON<any>({ ...ping }), (e: any) => e.status === 429 && /rate limit, not a key problem/.test(e.message) && /try again in/.test(e.message));
assert.ok(Date.now() - t0 < 3000, 'a person is not kept waiting for a long rate limit');
console.log('quick: long rate limit → fails at once with "rate limit, not a key problem" ✓');

// 5. the message alone says how long to wait (no retry-after header)
await ctl({ reset: true, groq: { tpm: 1000, windowMs: 2000, noRetryHeader: true, refill: true } });
const p2 = makeClient(llmConfig(env())!, { patient: true });
const both = await Promise.all([p2.chatJSON<any>(ping), p2.chatJSON<any>(ping), p2.chatJSON<any>(ping)]);
assert.ok(both.every((x) => x.data.ok));
console.log(`no retry-after header: waited per "try again in …" (${(await ctl({})).stats.groq_429} × 429) ✓`);

// 6. daily cap: fail at once, then stop calling for that model until the time is up
await ctl({ reset: true, groq: { tpm: 8000, windowMs: 60000, noRetryHeader: false, dailyCapped: true, refill: true } });
const p3 = makeClient(llmConfig(env({ GROQ_MODEL: 'openai/gpt-oss-20b' }))!, { patient: true });
t0 = Date.now();
await assert.rejects(p3.chatJSON<any>(ping), (e: any) => e.status === 429 && /tokens per day/.test(e.message));
await assert.rejects(p3.chatJSON<any>(ping), (e: any) => e.status === 429);
assert.ok(Date.now() - t0 < 2000);
assert.equal((await ctl({})).stats.groq_429_daily, 1, 'second call did not reach the API');
console.log('daily cap: fails at once, later calls skip the API ✓');

// 7. a background job close to its time limit does not wait past its deadline
await ctl({ reset: true, groq: { tpm: 600, windowMs: 120000, dailyCapped: false, refill: true } });
const late = makeClient(llmConfig(env())!, { patient: true, deadline: Date.now() + 8000 });
await late.chatJSON<any>(ping); // takes most of the bucket; the next call would have to wait ~50 s
t0 = Date.now();
await assert.rejects(late.chatJSON<any>(ping), (e: any) => e.status === 429);
assert.ok(Date.now() - t0 < 4000, 'gave up instead of waiting past the deadline');
console.log('deadline: no wait past the job\'s time limit ✓');

// 8. a wrong model name is a clear error
await ctl({ reset: true, groq: { dailyCapped: false } });
await assert.rejects(makeClient(llmConfig(env({ GROQ_MODEL: 'gpt-oss-120b' }))!).chatJSON<any>(ping), (e: any) => e.status === 404 && /does not exist/.test(e.message) && /^Groq 404/.test(e.message));
console.log('unknown model: "Groq 404: The model … does not exist" ✓');
await ctl({ reset: true, groq: { tpm: 8000, windowMs: 60000, refill: true, latencyMs: 150 } });
console.log('Groq client OK');
