// Mock of the OpenAI REST API for local tests: /v1/chat/completions (json_schema) and /v1/embeddings.
// It checks the request shape the app sends and answers with plausible JSON built from the comment.
import http from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { buildDataset } from '../team-console/src/ingest';
import { SearchEngine, buildAliasDocs } from '../team-console/src/search';
import { understandRules, postProductsRules } from '../team-console/src/understand';
import { fnv1a, normalize, tokens } from '../team-console/src/text';

const PORT = Number(process.env.MOCK_PORT || 8899);
const LOG = process.env.MOCK_LOG || '/tmp/mock-openai.log';
const csv = readFileSync(new URL('../team-console/public/sample/pos_availability.csv', import.meta.url), 'utf8');
const ds = buildDataset(csv);
const engine = new SearchEngine(ds.entries, { version: 1, docs: buildAliasDocs(ds.entries), built_at: '' }, null);
let failNext: string | null = null;
let failTimes = 0;
let stats: Record<string, number> = {};

function vec(text: string, dims: number): number[] {
  const v = new Array(dims).fill(0);
  for (const tok of tokens(text)) {
    const t = `#${tok}#`;
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= t.length; i++) v[fnv1a(t.slice(i, i + n)) % dims] += 1;
  }
  const s = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / s);
}

function check(cond: unknown, msg: string) {
  if (!cond) throw Object.assign(new Error(msg), { status: 400 });
}

async function produce(name: string, userText: string, images: number): Promise<any> {
  let out: any;
  if (name === 'understand_comment') {
    const comment = (userText.match(/Comment: ([\s\S]*)$/) || [])[1] || '';
    const fixed = comment.replace(/زيتوون/g, 'زيتون');
    const u = await understandRules(fixed, engine);
    const packM = normalize(comment).match(/(\d+(?:\.\d+)?)\s*(كيلو|كغ|غرام|غ|g|kg|ml|مل|لتر)|الكبير|الصغير|الوسط|big|large|small/);
    out = {
      intent: u.intent,
      language: /[؀-ۿ]/.test(comment) ? 'ar' : 'en',
      products: u.products.map((p) => (normalize(p).startsWith('زيت') && /زيتون/.test(fixed) ? 'زيت زيتون' : p)),
      uses_post_product: u.uses_post_product,
      pack: packM ? packM[0] : null,
      locations: u.locations,
      stores: u.stores,
      wants_price: u.wants_price,
      short_reply: u.intent === 'praise' ? 'شكراً كتير على كلامك الحلو، بالصحة والهنا! 🙏' : u.intent === 'complaint' ? 'بنعتذر منك كتير 🙏 ابعتلنا رسالة خاصة فيها اسم المحل وتاريخ الشراء لنتابع معك.' : u.intent === 'other_question' ? 'سؤال حلو! رح نتأكد ونرد عليك قريباً 🙏' : null,
      reason: `mock: ${u.reason}`,
    };
  } else if (name === 'compose_reply') {
    const factsText = userText.split('Facts (JSON):\n')[1] || '{}';
    const facts = JSON.parse(factsText);
    const comment = (userText.match(/Customer comment: ([^\n]*)/) || [])[1] || '';
    const ar = /Arabic/.test(facts.reply_language);
    const lines: string[] = [ar ? `أهلاً ${facts.customer_first_name || ''}!` : `Hi ${facts.customer_first_name || ''}!`];
    for (const p of facts.products) {
      if (!p.shops.length && p.total_shops_with_it_on_shelf) {
        lines.push(ar ? `${p.name_ar} متوفر بـ${p.total_shops_with_it_on_shelf} محل، أكثرها ${p.top_cities.map((c: any) => c.city_ar).join(' و')}. وين منطقتك؟` : `${p.name_en} is at ${p.total_shops_with_it_on_shelf} shops. Which area are you in?`);
      } else if (!p.shops.length) lines.push(ar ? `للأسف ${p.name_ar} مش متوفر حالياً.` : `Sorry, ${p.name_en} is not on the shelf right now.`);
      for (const s of p.shops) lines.push(ar ? `• ${s.name_ar} (آخر زيارة لمندوبنا ${s.last_visit_ar})` : `• ${s.name_en} (our rep's last visit ${s.last_visit_en})`);
      if (facts.asked_about_price && p.shelf_price_range_jod.length) lines.push(ar ? `السعر بين ${p.shelf_price_range_jod[0].min.toFixed(2)} و${p.shelf_price_range_jod[0].max.toFixed(2)} دينار حسب المحل.` : `Price JOD ${p.shelf_price_range_jod[0].min.toFixed(2)}-${p.shelf_price_range_jod[0].max.toFixed(2)}.`);
    }
    if (/#hallucinate/.test(comment)) lines.push(ar ? 'وكمان عند كارفور سيتي مول (آخر زيارة 30 أيلول) بسعر 1.99 دينار' : 'Also at Carrefour City Mall (visited 30 Sep) for JOD 1.99');
    lines.push(ar ? 'تأكد من المحل قبل ما تروح 🙏' : 'Check with the shop before you go 🙏');
    out = { reply: lines.join('\n') };
  } else if (name === 'analyze_post') {
    const caption = (userText.match(/Caption: ([\s\S]*)$/) || [])[1] || '';
    const found = await postProductsRules(caption, engine);
    out = { products: found.map((m) => ({ name: m.entry.name, pack: null })), summary: `mock summary (${images} image${images === 1 ? '' : 's'})` };
  } else if (name === 'ping') out = { ok: true };
  else throw Object.assign(new Error(`unknown schema ${name}`), { status: 400 });
  return out;
}

async function handleChat(body: any) {
  check(typeof body.model === 'string', 'model is required');
  check(Array.isArray(body.messages) && body.messages.length === 2, 'two messages expected');
  const rf = body.response_format;
  if (rf?.type === 'json_schema' && openaiFlags.noJsonSchema) {
    stats.openai_rejected_schema = (stats.openai_rejected_schema || 0) + 1;
    throw fail(400, "response_format 'json_schema' is not supported by this model; use 'json_object'.");
  }
  if (rf?.type === 'json_object') {
    check(/JSON Schema exactly/.test(body.messages[0].content), 'json_object mode needs the schema in the system prompt');
    stats.openai_json_object = (stats.openai_json_object || 0) + 1;
    const sys = body.messages[0].content as string;
    const name = /You read Instagram comments/.test(sys) ? 'understand_comment' : /public reply/.test(sys) ? 'compose_reply' : /food brand's Instagram post/.test(sys) ? 'analyze_post' : 'ping';
    const userMsg = body.messages[1].content;
    const userText = typeof userMsg === 'string' ? userMsg : userMsg.find((p: any) => p.type === 'text')?.text || '';
    const out = await produce(name, userText, 0);
    return { id: 'chatcmpl-mock', object: 'chat.completion', model: body.model + '-mock', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(out), refusal: null }, finish_reason: 'stop' }], usage: { total_tokens: 321 } };
  }
  check(rf?.type === 'json_schema' && rf.json_schema?.strict === true && rf.json_schema?.schema?.type === 'object', 'response_format json_schema strict expected');
  check(typeof body.max_completion_tokens === 'number', 'max_completion_tokens expected');
  if (/^gpt-5/.test(body.model)) {
    check(body.temperature === undefined, 'gpt-5 models do not accept temperature');
    check(body.reasoning_effort === 'low', 'reasoning_effort low expected');
  }
  // strict schemas: every property must be required, no extra properties
  const schema = rf.json_schema.schema;
  const walk = (s: any) => {
    if (s?.type === 'object') {
      check(s.additionalProperties === false, 'additionalProperties false required');
      check(JSON.stringify(Object.keys(s.properties).sort()) === JSON.stringify([...s.required].sort()), `all properties must be required in ${rf.json_schema.name}`);
      Object.values(s.properties).forEach(walk);
    }
    if (s?.type === 'array') walk(s.items);
  };
  walk(schema);
  const name = rf.json_schema.name;
  stats[name] = (stats[name] || 0) + 1;
  if (failNext === name) {
    if (--failTimes <= 0) failNext = null;
    throw Object.assign(new Error('Simulated upstream failure'), { status: 500 });
  }
  const userMsg = body.messages[1].content;
  const userText = typeof userMsg === 'string' ? userMsg : userMsg.find((p: any) => p.type === 'text')?.text || '';
  const images = typeof userMsg === 'string' ? 0 : userMsg.filter((p: any) => p.type === 'image_url').length;
  const out = await produce(name, userText, images);
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), name, images, model: body.model }) + '\n');
  await new Promise((r) => setTimeout(r, 120));
  return { id: 'chatcmpl-mock', object: 'chat.completion', model: body.model + '-mock', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(out), refusal: null }, finish_reason: 'stop' }], usage: { total_tokens: 321 } };
}

// ---------- Gemini (generateContent + batchEmbedContents), as strict as the real API on what matters here ----------
let gemini = { rejectJsonSchema: false, rejectThinking: false, headerKeyInvalid: false };
let openaiFlags = { noJsonSchema: false };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

async function handleGemini(model: string, body: any) {
  const sys = body.systemInstruction?.parts?.[0]?.text;
  check(typeof sys === 'string' && sys.length > 0, 'systemInstruction.parts[0].text is required');
  const c = body.contents?.[0];
  check(c && c.role === 'user' && Array.isArray(c.parts) && typeof c.parts[0]?.text === 'string', 'contents[0] must be a user turn with text first');
  const gc = body.generationConfig || {};
  check(gc.responseMimeType === 'application/json', 'responseMimeType application/json expected');
  if (gc.responseJsonSchema && gc.responseSchema) throw fail(400, 'responseJsonSchema and responseSchema are mutually exclusive');
  if (gc.thinkingConfig && gemini.rejectThinking) {
    stats.gemini_rejected = (stats.gemini_rejected || 0) + 1;
    throw fail(400, 'Thinking level is not supported for this model.');
  }
  if (gc.responseJsonSchema) {
    if (gemini.rejectJsonSchema) {
      stats.gemini_rejected = (stats.gemini_rejected || 0) + 1;
      throw fail(400, "Invalid JSON payload received. Unknown name \"responseJsonSchema\" at 'generation_config': Cannot find field.");
    }
    check(gc.responseJsonSchema.type === 'object', 'responseJsonSchema must be an object schema');
  }
  if (gc.responseSchema) {
    const walk = (x: any) => {
      if ('additionalProperties' in x) throw fail(400, "Invalid JSON payload received. Unknown name \"additionalProperties\" at 'generation_config.response_schema': Cannot find field.");
      check(/^[A-Z]+$/.test(x.type), 'responseSchema types must be upper case');
      if (x.properties) Object.values(x.properties).forEach(walk);
      if (x.items) walk(x.items);
    };
    walk(gc.responseSchema);
  }
  if (!gc.responseJsonSchema && !gc.responseSchema) check(/JSON Schema exactly/.test(sys), 'without a schema field, the schema must be in the prompt');
  const name = /You read Instagram comments/.test(sys) ? 'understand_comment' : /public reply/.test(sys) ? 'compose_reply' : /food brand's Instagram post/.test(sys) ? 'analyze_post' : /Reply with JSON/.test(sys) ? 'ping' : 'unknown';
  stats[`gemini_${name}`] = (stats[`gemini_${name}`] || 0) + 1;
  (stats as any).gemini_mode = gc.responseJsonSchema ? 'json' : gc.responseSchema ? 'openapi' : 'plain';
  (stats as any).gemini_thinking = gc.thinkingConfig ? JSON.stringify(gc.thinkingConfig) : 'none';
  if (failNext === name) {
    if (--failTimes <= 0) failNext = null;
    throw fail(500, 'Simulated upstream failure');
  }
  const images = c.parts.filter((p: any) => p.inlineData && p.inlineData.data && p.inlineData.mimeType).length;
  const out = await produce(name, c.parts[0].text, images);
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), name, images, model, provider: 'gemini' }) + '\n');
  await new Promise((r) => setTimeout(r, 120));
  return { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { totalTokenCount: 321 }, modelVersion: `${model}-mock` };
}

function handleGeminiEmbed(model: string, body: any) {
  check(Array.isArray(body.requests) && body.requests.length > 0 && body.requests.length <= 100, 'requests must hold 1 to 100 items');
  for (const r of body.requests) {
    check(r.model === `models/${model}`, 'each request needs model "models/<name>"');
    check(typeof r.content?.parts?.[0]?.text === 'string', 'content.parts[0].text is required');
    check(typeof r.outputDimensionality === 'number', 'outputDimensionality expected');
  }
  stats.gemini_embed_calls = (stats.gemini_embed_calls || 0) + 1;
  stats.gemini_embedded_texts = (stats.gemini_embedded_texts || 0) + body.requests.length;
  // not normalized on purpose: the real API does not normalize reduced sizes either
  return { embeddings: body.requests.map((r: any) => ({ values: vec(r.content.parts[0].text, r.outputDimensionality).map((x) => x * 2.5) })) };
}

// ---------- Groq (OpenAI-compatible, served here under /groq/openai/v1) with its free-tier limits ----------
// The free tier counts the prompt plus max_completion_tokens against tokens per minute; tests shrink the window.
let groq = { tpm: 8000, windowMs: 60000, dailyCapped: false, failedGeneration: 0, noStrict: false, noRetryHeader: false, latencyMs: 150 };
let bucket = { tokens: 8000, at: Date.now() };
const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct'];
type Out = { status: number; body: any; headers?: Record<string, string> };
const gErr = (status: number, message: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Out => ({ status, headers, body: { error: { message, type: 'invalid_request_error', ...extra } } });
const bump = (k: string) => (stats[k] = (stats[k] || 0) + 1);

async function handleGroq(body: any): Promise<Out> {
  if (!GROQ_MODELS.includes(body.model)) return gErr(404, `The model \`${body.model}\` does not exist or you do not have access to it.`, { code: 'model_not_found' });
  check(Array.isArray(body.messages) && body.messages.length === 2, 'two messages expected');
  check(typeof body.max_completion_tokens === 'number', 'max_completion_tokens expected');
  const userMsg = body.messages[1].content;
  if (typeof userMsg !== 'string' && !/llama-4/.test(body.model)) {
    bump('groq_images_rejected');
    return gErr(400, "'messages.1' : for 'role:user' the following must be satisfied[('messages.1.content' : value must be a string)]");
  }
  if (/gpt-oss/.test(body.model)) {
    check(body.reasoning_effort === undefined || ['low', 'medium', 'high'].includes(body.reasoning_effort), 'reasoning_effort must be one of low, medium, high');
    (stats as any).groq_reasoning = body.reasoning_effort || 'none';
  } else if (body.reasoning_effort !== undefined) return gErr(400, '`reasoning_effort` is not supported with this model');
  const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 3);
  const requested = promptTokens + body.max_completion_tokens;
  stats.groq_max_tokens_seen = Math.max(stats.groq_max_tokens_seen || 0, body.max_completion_tokens);
  stats.groq_requested_max = Math.max(stats.groq_requested_max || 0, requested);
  if (groq.dailyCapped) {
    bump('groq_429_daily');
    return gErr(429, `Rate limit reached for model \`${body.model}\` in organization \`org_mock\` service tier \`on_demand\` on tokens per day (TPD): Limit 200000, Used 199800, Requested ${requested}. Please try again in 59m59.9s.`, { type: 'tokens', code: 'rate_limit_exceeded' }, groq.noRetryHeader ? {} : { 'retry-after': '3600' });
  }
  if (requested > groq.tpm) {
    bump('groq_413');
    return gErr(413, `Request too large for model \`${body.model}\` in organization \`org_mock\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${groq.tpm}, Requested ${requested}, please reduce your message size and try again.`, { type: 'tokens', code: 'rate_limit_exceeded' });
  }
  const now = Date.now();
  bucket.tokens = Math.min(groq.tpm, bucket.tokens + ((now - bucket.at) * groq.tpm) / groq.windowMs);
  bucket.at = now;
  if (bucket.tokens < requested) {
    const waitMs = ((requested - bucket.tokens) * groq.windowMs) / groq.tpm;
    bump('groq_429');
    return gErr(429, `Rate limit reached for model \`${body.model}\` in organization \`org_mock\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${groq.tpm}, Used ${Math.round(groq.tpm - bucket.tokens)}, Requested ${requested}. Please try again in ${(waitMs / 1000).toFixed(2)}s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing`, { type: 'tokens', code: 'rate_limit_exceeded' }, groq.noRetryHeader ? {} : { 'retry-after': String(Math.ceil(waitMs / 1000)) });
  }
  const rf = body.response_format;
  const sys = String(body.messages[0].content || '');
  let name: string;
  if (rf?.type === 'json_schema') {
    if (groq.noStrict || !/gpt-oss/.test(body.model)) {
      bump('groq_rejected_schema');
      return gErr(400, 'This model does not support response format `json_schema`. See supported models at https://console.groq.com/docs/structured-outputs#supported-models');
    }
    check(rf.json_schema?.strict === true && rf.json_schema?.schema?.type === 'object', 'json_schema strict expected');
    const walk = (x: any) => {
      if (x?.type === 'object') {
        check(x.additionalProperties === false, 'additionalProperties false required in strict mode');
        check(JSON.stringify(Object.keys(x.properties).sort()) === JSON.stringify([...x.required].sort()), 'all properties must be required in strict mode');
        Object.values(x.properties).forEach(walk);
      }
      if (x?.type === 'array') walk(x.items);
    };
    walk(rf.json_schema.schema);
    name = rf.json_schema.name;
  } else if (rf?.type === 'json_object') {
    if (!/json/i.test(JSON.stringify(body.messages))) return gErr(400, "'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'.");
    bump('groq_json_object');
    name = /You read Instagram comments/.test(sys) ? 'understand_comment' : /public reply/.test(sys) ? 'compose_reply' : /Instagram post/.test(sys) ? 'analyze_post' : 'ping';
  } else return gErr(400, 'response_format expected in this mock');
  bucket.tokens -= requested;
  const userText = typeof userMsg === 'string' ? userMsg : userMsg.find((x: any) => x.type === 'text')?.text || '';
  const out = await produce(name, userText, 0);
  if (groq.failedGeneration > 0) {
    groq.failedGeneration--;
    bump('groq_failed_generation');
    return gErr(400, "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.", { code: 'json_validate_failed', failed_generation: `Sure! Here is the JSON you asked for:\n${JSON.stringify(out)}\nHope this helps.` });
  }
  bump(`groq_${name}`);
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), name, images: 0, model: body.model, provider: 'groq', requested }) + '\n');
  await new Promise((r) => setTimeout(r, groq.latencyMs));
  const content = JSON.stringify(out);
  return {
    status: 200,
    headers: { 'x-ratelimit-limit-tokens': String(groq.tpm), 'x-ratelimit-remaining-tokens': String(Math.max(0, Math.floor(bucket.tokens))), 'x-ratelimit-reset-tokens': `${(((groq.tpm - bucket.tokens) * groq.windowMs) / groq.tpm / 1000).toFixed(2)}s` },
    body: { id: 'chatcmpl-groq-mock', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content, reasoning: 'The customer is asking about a product. (mock reasoning)' }, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(content.length / 3), total_tokens: promptTokens + Math.ceil(content.length / 3) } },
  };
}

// ---------- Jina embeddings (same path as OpenAI's, told apart by the jina_ key) ----------
let jina = { missingModels: [] as string[] };
function handleJinaEmbed(body: any) {
  check(typeof body.model === 'string', 'model is required');
  if (jina.missingModels.includes(body.model)) throw fail(422, `Model '${body.model}' is not available. Check the model name.`);
  check(Array.isArray(body.input) && body.input.every((t: unknown) => typeof t === 'string'), 'input must be an array of strings');
  check(body.task === 'text-matching', 'task text-matching expected');
  check(typeof body.dimensions === 'number', 'dimensions expected');
  stats.jina_embed_calls = (stats.jina_embed_calls || 0) + 1;
  stats.jina_embedded_texts = (stats.jina_embedded_texts || 0) + body.input.length;
  (stats as any).jina_model = body.model;
  return { model: body.model, object: 'list', usage: { total_tokens: body.input.length * 4, prompt_tokens: body.input.length * 4 }, data: body.input.map((t: string, i: number) => ({ object: 'embedding', index: i, embedding: vec(t, body.dimensions) })) };
}

http
  .createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.url === '/__control') {
        const b = JSON.parse(raw || '{}');
        if ('fail' in b) {
          failNext = b.fail;
          failTimes = b.times || 1;
        }
        if (b.reset) stats = {};
        if (b.gemini) gemini = { ...gemini, ...b.gemini };
        if (b.jina) jina = { ...jina, ...b.jina };
        if (b.openai) openaiFlags = { ...openaiFlags, ...b.openai };
        if (b.groq) {
          groq = { ...groq, ...b.groq };
          if ('tpm' in b.groq || 'windowMs' in b.groq || b.groq.refill) bucket = { tokens: groq.tpm, at: Date.now() };
        }
        return send(200, { ok: true, stats, failNext, gemini, jina, openai: openaiFlags, groq, bucket: Math.floor(bucket.tokens) });
      }
      const gm = (req.url || '').match(/^\/v1beta\/models\/([^:/?]+):(generateContent|batchEmbedContents)(\?key=[^&]+)?$/);
      if (gm) {
        const viaHeader = !!req.headers['x-goog-api-key'];
        check(viaHeader || gm[3], 'missing API key');
        if (viaHeader && gemini.headerKeyInvalid) {
          stats.gemini_bad_key = (stats.gemini_bad_key || 0) + 1;
          throw fail(400, 'API key not valid. Please pass a valid API key.');
        }
        if (gm[3]) stats.gemini_query_key = (stats.gemini_query_key || 0) + 1;
        const gbody = JSON.parse(raw || '{}');
        if (gm[2] === 'generateContent') return send(200, await handleGemini(decodeURIComponent(gm[1]), gbody));
        return send(200, handleGeminiEmbed(decodeURIComponent(gm[1]), gbody));
      }
      check(req.headers.authorization?.startsWith('Bearer '), 'missing bearer token');
      const body = JSON.parse(raw || '{}');
      if ((req.url || '').startsWith('/groq/openai/v1/')) {
        if (!/^Bearer gsk_/.test(req.headers.authorization || '')) return send(401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });
        if (req.url === '/groq/openai/v1/chat/completions') {
          const r = await handleGroq(body);
          return send(r.status, r.body, r.headers);
        }
        bump('groq_unexpected_path');
        return send(404, { error: { message: `Unknown request URL: POST ${req.url}. Please check the URL for typos.`, type: 'invalid_request_error', code: 'unknown_url' } });
      }
      if (req.url === '/v1/chat/completions') return send(200, await handleChat(body));
      if (req.url === '/v1/embeddings' && /^Bearer jina_/.test(req.headers.authorization || '')) return send(200, handleJinaEmbed(body));
      if (req.url === '/v1/embeddings') {
        check(Array.isArray(body.input) && body.input.length <= 2048, 'input must be an array of at most 2048');
        check(typeof body.dimensions === 'number', 'dimensions expected');
        stats.embeddings = (stats.embeddings || 0) + 1;
        stats.embedded_texts = (stats.embedded_texts || 0) + body.input.length;
        return send(200, { object: 'list', model: body.model, data: body.input.map((t: string, i: number) => ({ object: 'embedding', index: i, embedding: vec(t, body.dimensions) })) });
      }
      send(404, { error: { message: 'not found' } });
    } catch (e: any) {
      send(e.status || 500, { error: { message: e.message } });
    }
  })
  .listen(PORT, () => console.log(`mock OpenAI + Gemini on ${PORT}`));
