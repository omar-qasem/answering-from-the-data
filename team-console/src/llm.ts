// AI clients over plain fetch, in two separate roles:
// - a chat model (Groq, Gemini or any OpenAI-compatible API) reads comments and writes replies, answering in JSON;
// - an embedding model (Jina, Gemini or OpenAI) turns names into vectors for the hybrid search.
// Each role is optional. Keys only come from environment variables set in Netlify.

export type Provider = 'groq' | 'gemini' | 'openai';
export type EmbedProvider = 'jina' | 'gemini' | 'openai';

export interface LlmConfig {
  provider: Provider;
  apiKey: string;
  model: string;
  embedModel: string;
  embedDims: number;
  baseUrl: string;
  maxOut?: number; // cap on output tokens per call: Groq's free tier counts the cap, not the tokens used, against its per-minute limit
}

export interface EmbedConfig {
  provider: EmbedProvider;
  apiKey: string;
  model: string;
  dims: number;
  baseUrl: string;
}

const NAMES: Record<string, string> = { groq: 'Groq', gemini: 'Gemini', openai: 'OpenAI', jina: 'Jina' };
export const providerName = (p: string) => NAMES[p] || p;

// keys pasted into Netlify sometimes carry quotes or a header name; keep only the key itself
const cleanKey = (k?: string) =>
  String(k || '')
    .trim()
    .replace(/^(x-goog-api-key|authorization)\s*:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();

export function llmConfig(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const groqKey = cleanKey(env.GROQ_API_KEY);
  const gemKey = cleanKey(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  const oaiKey = cleanKey(env.OPENAI_API_KEY);
  const want = (env.LLM_PROVIDER || '').trim().toLowerCase();
  const dims = Number(env.EMBED_DIMS || env.OPENAI_EMBED_DIMS || 256) || 256;
  // Groq: an OpenAI-compatible API with a free tier (no embeddings; Jina covers those)
  const groq = (): LlmConfig => ({
    provider: 'groq',
    apiKey: groqKey,
    model: (env.GROQ_MODEL || 'openai/gpt-oss-120b').trim(),
    embedModel: '',
    embedDims: dims,
    baseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    maxOut: Math.min(4000, Math.max(300, Number(env.GROQ_MAX_TOKENS) || 1000)), // the prompt plus this cap must fit in one minute's allowance
  });
  const gemini = (): LlmConfig => ({
    provider: 'gemini',
    apiKey: gemKey,
    model: (env.GEMINI_MODEL || 'gemini-flash-latest').trim().replace(/^models\//, ''),
    embedModel: (env.GEMINI_EMBED_MODEL || 'gemini-embedding-001').trim().replace(/^models\//, ''),
    embedDims: dims,
    baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
  });
  const openai = (): LlmConfig => ({
    provider: 'openai',
    apiKey: oaiKey,
    model: (env.OPENAI_MODEL || 'gpt-5-mini').trim(),
    embedModel: (env.OPENAI_EMBED_MODEL || 'text-embedding-3-small').trim(),
    embedDims: dims,
    baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  });
  if (want === 'groq' && groqKey) return groq();
  if (want === 'openai' && oaiKey) return openai();
  if (want === 'gemini' && gemKey) return gemini();
  if (want === 'none') return null;
  if (groqKey) return groq();
  if (gemKey) return gemini();
  if (oaiKey) return openai();
  return null;
}

// Embeddings: Jina when JINA_API_KEY is set (free tokens on sign-up), otherwise the chat provider's own embeddings.
export function embedConfig(env: Record<string, string | undefined> = process.env, chat: LlmConfig | null = llmConfig(env)): EmbedConfig | null {
  const jinaKey = cleanKey(env.JINA_API_KEY);
  const want = (env.EMBED_PROVIDER || '').trim().toLowerCase();
  const dims = Number(env.EMBED_DIMS || env.OPENAI_EMBED_DIMS || 256) || 256;
  if (want === 'none') return null;
  if (jinaKey && (want === 'jina' || !want || !chat)) {
    return { provider: 'jina', apiKey: jinaKey, model: (env.JINA_EMBED_MODEL || 'jina-embeddings-v5-text-small').trim(), dims, baseUrl: (env.JINA_BASE_URL || 'https://api.jina.ai/v1').replace(/\/+$/, '') };
  }
  if (chat && chat.provider !== 'groq') return { provider: chat.provider, apiKey: chat.apiKey, model: chat.embedModel, dims: chat.embedDims, baseUrl: chat.baseUrl };
  return null; // Groq has no embedding API: add JINA_API_KEY for AI vectors in search
}

export class LlmError extends Error {
  status: number;
  body: any;
  constructor(message: string, status = 0, body: any = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface ChatJsonArgs {
  name: string;
  schema: Record<string, unknown>;
  system: string;
  user: string;
  images?: string[]; // data: URLs or https URLs (dropped for models that read text only)
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatJsonResult<T> {
  data: T;
  ms: number;
  model: string;
  tokens: number | null;
}

export interface LlmClient {
  readonly cfg: LlmConfig;
  readonly vision: boolean; // false when the model reads text only (images are not sent)
  chatJSON<T>(a: ChatJsonArgs): Promise<ChatJsonResult<T>>;
}

export interface EmbedResult {
  vecs: Float32Array[];
  model: string; // the model that actually answered (Jina may fall back to an older model name)
}

export interface EmbedClient {
  readonly cfg: EmbedConfig;
  embed(texts: string[], model?: string): Promise<EmbedResult>;
}

// Background jobs are patient: on a rate limit (429) they wait as long as the API asks and try again, several times.
// Calls a person is waiting for retry once, briefly, and then the graphs fall back to rules and templates.
export interface ClientOpts {
  patient?: boolean;
  deadline?: number; // epoch ms: never wait or keep a request open past this (a background job's time limit)
  onWait?: (ms: number, why: string) => void; // told before each rate-limit wait, so a job can show it
}

interface Patience {
  retries: number;
  maxWaitMs: number; // longest single wait
  giveUpMs: number; // if the API asks for a longer wait than this (a daily cap), fail now instead
  deadline?: number;
  onWait?: (ms: number, why: string) => void;
}

const patienceFor = (o: ClientOpts = {}): Patience =>
  o.patient ? { retries: 8, maxWaitMs: 60000, giveUpMs: 120000, deadline: o.deadline, onWait: o.onWait } : { retries: 1, maxWaitMs: 10000, giveUpMs: 10000, deadline: o.deadline, onWait: o.onWait };

export function makeClient(cfg: LlmConfig, opts: ClientOpts = {}): LlmClient {
  return cfg.provider === 'gemini' ? new GeminiClient(cfg, opts) : new OpenAIClient(cfg, opts);
}

export function makeEmbedder(cfg: EmbedConfig, opts: ClientOpts = {}): EmbedClient {
  const p = patienceFor(opts);
  return {
    cfg,
    embed: (texts, model) => (cfg.provider === 'jina' ? jinaEmbed(cfg, texts, model, p) : cfg.provider === 'gemini' ? geminiEmbed(cfg, texts, model, p) : openaiEmbed(cfg, texts, model, p)),
  };
}

// ---------- shared ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// "7.66s", "2m59.56s", "1h2m3s", "500ms" -> milliseconds
export function parseDuration(t: string): number | null {
  const m = String(t || '')
    .trim()
    .match(/^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?$/);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  return ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000 + Number(m[4] || 0);
}

// How long a 429 asks us to wait: the retry-after header, else "try again in 4.77s" in the message, else the TPM reset header.
function retryAfterMs(res: Response, detail: string): number | null {
  const h = res.headers.get('retry-after');
  if (h && h.trim() && !Number.isNaN(Number(h))) return Number(h) * 1000;
  const inText = detail.match(/try again in ([\dhms.]+)/i)?.[1]?.replace(/\.$/, '');
  return parseDuration(inText || '') ?? parseDuration(res.headers.get('x-ratelimit-reset-tokens') || '');
}

// After a long rate-limit answer (a daily cap), calls to that model fail fast for a while (at most 10 minutes,
// then one call checks again).
const coolDown = new Map<string, { until: number; msg: string }>();

async function postJSON(url: string, headers: Record<string, string>, body: any, timeoutMs: number, label: string, p: Patience): Promise<any> {
  const coolKey = `${url}|${body?.model || ''}`;
  const cd = coolDown.get(coolKey);
  if (cd && cd.until > Date.now()) throw new LlmError(cd.msg, 429);
  let lastErr: unknown = null;
  const attempts = 1 + p.retries;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const left = p.deadline ? p.deadline - Date.now() : Infinity;
    if (left < 3000) throw lastErr instanceof Error ? lastErr : new LlmError(`${label}: out of time for this job`);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(timeoutMs, left)) });
    } catch (e) {
      lastErr = new LlmError(`${label} request failed: ${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}`);
      if (attempt < attempts - 1) continue;
      throw lastErr;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok) return json;
    const detail = json?.error?.message || (typeof json?.detail === 'string' ? json.detail : json?.detail ? JSON.stringify(json.detail) : '') || text.slice(0, 300) || res.statusText;
    if (res.status === 429) {
      const asked = retryAfterMs(res, detail);
      const msg = `${label} 429 (rate limit, not a key problem): ${detail}`;
      if (asked !== null && asked > p.giveUpMs) {
        if (asked > 120000) coolDown.set(coolKey, { until: Date.now() + Math.min(asked, 10 * 60000), msg });
        throw new LlmError(msg, 429, json);
      }
      lastErr = new LlmError(msg, 429, json);
      if (attempt >= attempts - 1) throw lastErr;
      const wait = Math.min(p.maxWaitMs, (asked ?? 2000) + 250 + Math.floor(Math.random() * 500));
      if (p.deadline && Date.now() + wait + 3000 > p.deadline) throw lastErr; // the job would run out of time waiting
      p.onWait?.(wait, `${label} rate limit`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500 && attempt < attempts - 1) {
      lastErr = new LlmError(`${label} ${res.status}: ${detail}`, res.status, json);
      await sleep(1500);
      continue;
    }
    throw new LlmError(`${label} ${res.status}: ${detail}`, res.status, json);
  }
  throw lastErr instanceof Error ? lastErr : new LlmError(`${label} request failed`);
}

function unitVec(v: Float32Array): Float32Array {
  let s = 0;
  for (let k = 0; k < v.length; k++) s += v[k] * v[k];
  const n = Math.sqrt(s) || 1;
  for (let k = 0; k < v.length; k++) v[k] /= n;
  return v;
}

export function parseJsonLoose<T>(raw: string): T {
  const t = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // reasoning models that think out loud
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(t) as T;
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1)) as T;
      } catch {}
    }
    throw new LlmError('The model did not return valid JSON.');
  }
}

const schemaHint = (schema: unknown) => `\nAnswer with one JSON object that matches this JSON Schema exactly:\n${JSON.stringify(schema)}`;

// ---------- Jina embeddings ----------
// Jina's free key covers embeddings only (it has no fast chat model). If the configured model name is not
// available, the next known name is tried, and the one that worked is recorded with the index.
const JINA_MODELS = ['jina-embeddings-v5-text-small', 'jina-embeddings-v4', 'jina-embeddings-v3'];
const jinaWorking = new Map<string, string>();

async function jinaEmbed(cfg: EmbedConfig, texts: string[], model: string | undefined, p: Patience): Promise<EmbedResult> {
  const order = model ? [model] : [...new Set([jinaWorking.get(cfg.model) || cfg.model, cfg.model, ...JINA_MODELS])];
  let lastErr: unknown = null;
  for (const m of order) {
    try {
      const vecs: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 256) {
        const batch = texts.slice(i, i + 256).map((t) => t || ' ');
        const json = await postJSON(`${cfg.baseUrl}/embeddings`, { Authorization: `Bearer ${cfg.apiKey}` }, { model: m, input: batch, task: 'text-matching', dimensions: cfg.dims, normalized: true }, 30000, 'Jina', p);
        const rows = (json?.data || []).slice().sort((x: any, y: any) => x.index - y.index);
        if (rows.length !== batch.length) throw new LlmError('Embeddings came back with the wrong count.');
        for (const r of rows) vecs.push(unitVec(Float32Array.from(r.embedding as number[])));
      }
      if (!model) jinaWorking.set(cfg.model, m);
      return { vecs, model: m };
    } catch (e) {
      lastErr = e;
      const unknownModel = e instanceof LlmError && [400, 404, 422].includes(e.status) && /model/i.test(e.message);
      if (!unknownModel || model) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new LlmError('Jina embeddings failed');
}

// ---------- Gemini ----------
// JSON Schema (as used for OpenAI) -> the OpenAPI subset of the older responseSchema field.
export function toOpenApiSchema(s: any): any {
  if (!s || typeof s !== 'object') return s;
  let type = s.type;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes('null');
    type = type.find((t: string) => t !== 'null') || 'string';
  }
  const out: any = { type: String(type).toUpperCase() };
  if (nullable) out.nullable = true;
  if (s.enum) out.enum = s.enum;
  if (s.description) out.description = s.description;
  if (type === 'object' && s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toOpenApiSchema(v)]));
    if (s.required) out.required = s.required;
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (type === 'array' && s.items) out.items = toOpenApiSchema(s.items);
  return out;
}

async function imagePart(img: string): Promise<Record<string, unknown> | null> {
  const m = img.match(/^data:([^;]+);base64,(.+)$/);
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
  if (!/^https:\/\//.test(img)) return null;
  try {
    const res = await fetch(img, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_000_000) return null;
    return { inlineData: { mimeType: res.headers.get('content-type') || 'image/jpeg', data: buf.toString('base64') } };
  } catch {
    return null;
  }
}

// What each Gemini model and key accepted, remembered for the life of the function instance.
const learned = new Map<string, { schemaMode: 'json' | 'openapi' | 'plain'; thinking: boolean; keyInQuery: boolean }>();

function geminiCall(cfg: { baseUrl: string; apiKey: string }, path: string, body: unknown, timeoutMs: number, keyInQuery: boolean, p: Patience) {
  const url = `${cfg.baseUrl}${path}${keyInQuery ? `?key=${encodeURIComponent(cfg.apiKey)}` : ''}`;
  return postJSON(url, keyInQuery ? {} : { 'x-goog-api-key': cfg.apiKey }, body, timeoutMs, 'Gemini', p);
}

const isBadKey = (e: unknown) => e instanceof LlmError && (e.status === 400 || e.status === 401 || e.status === 403) && /api key not valid|api_key_invalid|invalid api key/i.test(e.message);

export class GeminiClient implements LlmClient {
  readonly cfg: LlmConfig;
  readonly vision = true;
  private readonly p: Patience;
  // newest first: JSON Schema field, then the older OpenAPI-style field, then plain JSON with the schema in the prompt
  private schemaMode: 'json' | 'openapi' | 'plain' = 'json';
  private thinking = true;
  private keyInQuery = false;

  constructor(cfg: LlmConfig, opts: ClientOpts = {}) {
    this.cfg = cfg;
    this.p = patienceFor(opts);
    const l = learned.get(cfg.model);
    if (l) Object.assign(this, l);
  }

  private remember() {
    learned.set(this.cfg.model, { schemaMode: this.schemaMode, thinking: this.thinking, keyInQuery: this.keyInQuery });
  }

  async chatJSON<T>(a: ChatJsonArgs): Promise<ChatJsonResult<T>> {
    const t0 = Date.now();
    const parts: Record<string, unknown>[] = [{ text: a.user }];
    for (const img of a.images || []) {
      const part = await imagePart(img);
      if (part) parts.push(part);
    }
    const build = () => {
      const gc: Record<string, unknown> = { responseMimeType: 'application/json', maxOutputTokens: Math.max(a.maxTokens ?? 0, 8192) };
      if (this.schemaMode === 'json') gc.responseJsonSchema = a.schema;
      if (this.schemaMode === 'openapi') gc.responseSchema = toOpenApiSchema(a.schema);
      if (this.thinking) gc.thinkingConfig = { thinkingLevel: 'low' }; // short tasks: keep the thinking light and fast
      const system = this.schemaMode === 'plain' ? a.system + schemaHint(a.schema) : a.system;
      return { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig: gc };
    };
    const path = `/models/${encodeURIComponent(this.cfg.model)}:generateContent`;
    let json: any;
    let triedQueryKey = false;
    for (let tries = 0; ; tries++) {
      try {
        json = await geminiCall(this.cfg, path, build(), a.timeoutMs ?? 45000, this.keyInQuery, this.p);
        break;
      } catch (e) {
        const msg = (e as Error).message || '';
        if (isBadKey(e) && !triedQueryKey) {
          // some keys are only accepted as ?key= instead of the header; try that once before giving up
          triedQueryKey = true;
          this.keyInQuery = !this.keyInQuery;
          continue;
        }
        if (!(e instanceof LlmError) || e.status !== 400 || tries > 4) throw e;
        if (this.thinking && /thinking/i.test(msg)) this.thinking = false; // this model has no thinking level
        else if (this.schemaMode !== 'plain' && /schema|unknown name|cannot find field|invalid json payload/i.test(msg)) this.schemaMode = this.schemaMode === 'json' ? 'openapi' : 'plain';
        else throw e;
      }
    }
    this.remember();
    if (json?.promptFeedback?.blockReason) throw new LlmError(`Gemini blocked the request (${json.promptFeedback.blockReason}).`);
    const cand = json?.candidates?.[0];
    const text = ((cand?.content?.parts || []) as { text?: string; thought?: boolean }[])
      .filter((x) => typeof x.text === 'string' && !x.thought)
      .map((x) => x.text)
      .join('')
      .trim();
    if (!text) throw new LlmError(`Gemini returned no answer (${cand?.finishReason || 'empty response'}).`);
    return { data: parseJsonLoose<T>(text), ms: Date.now() - t0, model: json?.modelVersion || this.cfg.model, tokens: json?.usageMetadata?.totalTokenCount ?? null };
  }
}

async function geminiEmbed(cfg: EmbedConfig, texts: string[], model: string | undefined, p: Patience): Promise<EmbedResult> {
  const m = (model || cfg.model).replace(/^models\//, '');
  const keyInQuery = learned.get(`embed:${m}`)?.keyInQuery ?? false;
  const vecs: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100).map((t) => t || ' ');
    const body = { requests: batch.map((t) => ({ model: `models/${m}`, content: { parts: [{ text: t }] }, ...(/embedding-001$/.test(m) ? { taskType: 'SEMANTIC_SIMILARITY' } : {}), outputDimensionality: cfg.dims })) };
    let json: any;
    try {
      json = await geminiCall(cfg, `/models/${encodeURIComponent(m)}:batchEmbedContents`, body, 30000, keyInQuery, p);
    } catch (e) {
      if (!isBadKey(e)) throw e;
      json = await geminiCall(cfg, `/models/${encodeURIComponent(m)}:batchEmbedContents`, body, 30000, !keyInQuery, p);
      learned.set(`embed:${m}`, { schemaMode: 'json', thinking: false, keyInQuery: !keyInQuery });
    }
    const rows = (json?.embeddings || []) as { values?: number[] }[];
    if (rows.length !== batch.length) throw new LlmError('Embeddings came back with the wrong count.');
    for (const r of rows) vecs.push(unitVec(Float32Array.from(r.values || []))); // reduced sizes are not normalized by the API
  }
  return { vecs, model: m };
}

// ---------- OpenAI and OpenAI-compatible APIs (OpenAI, Groq) ----------
// Reasoning models (GPT-5, the o-series, gpt-oss) take reasoning_effort instead of a temperature.
const isReasoningModel = (m: string) => (/^(gpt-5|o\d)/i.test(m) && !/chat/i.test(m)) || /gpt-oss/i.test(m);
// Groq's production models read text only; its vision models carry one of these names.
const groqReadsImages = (m: string) => /llama-4|scout|maverick|vision|(^|[-/])vl($|[-/])/i.test(m);
const openaiLearned = new Map<string, { jsonObject: boolean; dropReasoning: boolean; dropTemperature: boolean; noImages: boolean }>();

export class OpenAIClient implements LlmClient {
  readonly cfg: LlmConfig;
  private readonly p: Patience;
  private dropReasoning = false;
  private dropTemperature = false;
  private jsonObject = false; // the API has no strict json_schema mode: ask for a JSON object and put the schema in the prompt
  private noImages = false; // the model reads text only

  constructor(cfg: LlmConfig, opts: ClientOpts = {}) {
    this.cfg = cfg;
    this.p = patienceFor(opts);
    if (cfg.provider === 'groq' && !groqReadsImages(cfg.model)) this.noImages = true;
    const l = openaiLearned.get(this.key);
    if (l) Object.assign(this, l);
  }

  private get key() {
    return `${this.cfg.baseUrl}|${this.cfg.model}`;
  }

  get vision(): boolean {
    return !this.noImages;
  }

  private call(path: string, body: unknown, timeoutMs: number) {
    return postJSON(`${this.cfg.baseUrl}${path}`, { Authorization: `Bearer ${this.cfg.apiKey}` }, body, timeoutMs, providerName(this.cfg.provider), this.p);
  }

  async chatJSON<T>(a: ChatJsonArgs): Promise<ChatJsonResult<T>> {
    const t0 = Date.now();
    const maxOut = Math.min(a.maxTokens ?? 2500, this.cfg.maxOut ?? Infinity);
    const build = () => {
      const imgs = this.noImages ? [] : a.images || [];
      const content = imgs.length ? [{ type: 'text', text: a.user }, ...imgs.map((url) => ({ type: 'image_url', image_url: this.cfg.provider === 'openai' ? { url, detail: 'low' } : { url } }))] : a.user;
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages: [
          { role: 'system', content: this.jsonObject ? a.system + schemaHint(a.schema) : a.system },
          { role: 'user', content },
        ],
        response_format: this.jsonObject ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: a.name, strict: true, schema: a.schema } },
        max_completion_tokens: maxOut,
      };
      if (isReasoningModel(this.cfg.model)) {
        if (!this.dropReasoning) body.reasoning_effort = 'low';
      } else if (!this.dropTemperature) body.temperature = 0.3;
      return body;
    };
    let json: any = null;
    let raw: string | null = null;
    for (let tries = 0; ; tries++) {
      try {
        json = await this.call('/chat/completions', build(), a.timeoutMs ?? 40000);
        break;
      } catch (e) {
        if (!(e instanceof LlmError) || e.status !== 400 || tries > 4) throw e;
        const m = e.message || '';
        // JSON mode can reject an answer that is valid JSON inside some extra text; the rejected text comes back with the error
        const failed = e.body?.error?.failed_generation;
        if (typeof failed === 'string' && failed.trim()) {
          try {
            parseJsonLoose(failed);
            raw = failed;
            break;
          } catch {
            if (tries < 1) continue; // a fresh try usually passes
            throw e;
          }
        }
        // some models or OpenAI-compatible services reject one of the optional knobs; drop it and retry
        if (/reasoning_effort/i.test(m) && !this.dropReasoning) this.dropReasoning = true;
        else if (/temperature/i.test(m) && !this.dropTemperature) this.dropTemperature = true;
        else if (/response_format|json_schema|structured|schema/i.test(m) && !this.jsonObject) this.jsonObject = true;
        else if (!this.noImages && a.images?.length && /image|vision|multimodal|content/i.test(m)) this.noImages = true;
        else throw e;
        openaiLearned.set(this.key, { jsonObject: this.jsonObject, dropReasoning: this.dropReasoning, dropTemperature: this.dropTemperature, noImages: this.noImages });
      }
    }
    if (raw === null) {
      const choice = json?.choices?.[0];
      const msg = choice?.message;
      if (msg?.refusal) throw new LlmError(`The model refused: ${msg.refusal}`);
      if (choice?.finish_reason === 'length') throw new LlmError(`The model ran out of tokens before finishing (limit ${maxOut}).`);
      raw = typeof msg?.content === 'string' ? msg.content : '';
    }
    return { data: parseJsonLoose<T>(raw ?? ''), ms: Date.now() - t0, model: json?.model || this.cfg.model, tokens: json?.usage?.total_tokens ?? null };
  }
}

async function openaiEmbed(cfg: EmbedConfig, texts: string[], model: string | undefined, p: Patience): Promise<EmbedResult> {
  const m = model || cfg.model;
  const vecs: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 500) {
    const batch = texts.slice(i, i + 500).map((t) => t || ' ');
    const json = await postJSON(`${cfg.baseUrl}/embeddings`, { Authorization: `Bearer ${cfg.apiKey}` }, { model: m, input: batch, dimensions: cfg.dims }, 30000, 'OpenAI', p);
    const rows = (json?.data || []).slice().sort((x: any, y: any) => x.index - y.index);
    if (rows.length !== batch.length) throw new LlmError('Embeddings came back with the wrong count.');
    for (const r of rows) vecs.push(unitVec(Float32Array.from(r.embedding as number[])));
  }
  return { vecs, model: m };
}
