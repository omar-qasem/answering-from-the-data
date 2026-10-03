// Browser entry for the Answer Path Explorer.
// It bundles the team console's own modules (ingest, search, query, reply, understand, the two graphs),
// so the page runs the same code as the backend on the sample file. Only the AI calls are absent:
// with no key, the graphs use the backend's own fallback (rules to read, templates to write).
import { SEED_CSV, SEED_CSV_NAME } from '../team-console/src/seed-csv';
import { PERSONAS, SEED_POSTS, seedRecords } from '../team-console/src/seed';
import { buildDataset, mapHeaders, parseCsv, storeKeyOf, type EntryType } from '../team-console/src/ingest';
import { ACCEPT, CONSIDER, MARGIN, SearchEngine, buildAliasDocs, cosine, decide, lightStem, localVector, type AliasDoc, type Match, type SearchIndexData } from '../team-console/src/search';
import { STOPWORDS, fnv1a, isStopword, normalize, tokenVariants, tokens } from '../team-console/src/text';
import { Catalog } from '../team-console/src/query';
import { askGraphDef, type AskDeps, type AskState, type Choice } from '../team-console/src/graphs/ask';
import { postGraphDef, type PostDeps, type PostState } from '../team-console/src/graphs/post';
import { compileGraph, type GraphDef } from '../team-console/src/graphs/runtime';
import { COMPOSE_SCHEMA, POST_SCHEMA, UNDERSTAND_SCHEMA, composePrompt, understandPrompt } from '../team-console/src/prompts';
import { factsFor, firstName } from '../team-console/src/reply';
import { hasArabic } from '../team-console/src/text';
import type { CommentRec, PostCtx, PostRec } from '../team-console/src/types';

const nowIso = () => new Date().toISOString();

// ---------- the same start-up the backend does after an upload ----------
const ds = buildDataset(SEED_CSV, SEED_CSV_NAME, nowIso());
const docs = buildAliasDocs(ds.entries);
const index: SearchIndexData = { version: 1, docs, built_at: nowIso() };
const engine = new SearchEngine(ds.entries, index, null);
const catalog = new Catalog(ds);
const seed = seedRecords(Date.now());

// The engine keeps its index private; the explorer reads it to show the numbers behind each ranking.
interface EngineInside {
  docs: AliasDoc[];
  local: Float32Array[];
  docVariants: Set<string>[];
  df: Map<string, number>;
  avgLen: number;
}
const inside = engine as unknown as EngineInside;

export const constants = { ACCEPT, CONSIDER, MARGIN, K1: 1.2, B: 0.75, RRF_K: 60, LOCAL_DIMS: 512, EXACT_BONUS: 0.05, CONTAINED_FLOOR: 0.78, SKIP_FZ: 0.35 };
export const schemas = { UNDERSTAND_SCHEMA, COMPOSE_SCHEMA, POST_SCHEMA };
export const stopwords = [...STOPWORDS];

// ---------- path 1: the data ----------
function csvField(f: string): string {
  return /[",\n\r;]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f;
}

export function dataInfo() {
  const table = parseCsv(SEED_CSV);
  const headers = table[0];
  const headerMap = mapHeaders(headers);
  const rawRows = table.length - 1;
  const iProduct = headerMap.product_name;
  const iCity = headerMap.city;
  let sampleAt = table.findIndex((r, i) => i > 0 && r[iProduct] === 'Olive Oil Extra Virgin' && r[iCity] === 'Zarqa');
  if (sampleAt < 0) sampleAt = 1;
  const sampleRaw = headers.map((h, i) => ({ column: h, value: table[sampleAt][i] }));
  // the real cleaning code, run on a file holding only that row
  const one = buildDataset([headers.map(csvField).join(','), table[sampleAt].map(csvField).join(',')].join('\n'), 'one-row.csv', nowIso());
  const sampleClean = one.rows[0];
  // how many raw rows share a shop and SKU (the "latest visit" step keeps one of each)
  const keys = new Map<string, number>();
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const k = `${storeKeyOf(r[headerMap.store_id] || r[headerMap.store_name])}|${normalize(r[headerMap.sku] || '')}`;
    keys.set(k, (keys.get(k) || 0) + 1);
  }
  const repeated = [...keys.values()].filter((n) => n > 1).length;
  const byType: Record<string, number> = {};
  for (const e of ds.entries) byType[e.type] = (byType[e.type] || 0) + 1;
  const docsByType: Record<string, number> = {};
  for (const d of docs) docsByType[d.type] = (docsByType[d.type] || 0) + 1;
  const olive = ds.entries.find((e) => e.id === 'product:olive oil extra virgin')!;
  const oliveDocs = docs.filter((d) => d.entryId === olive.id).map((d) => ({ text: d.text, norm: d.norm, toks: d.toks }));
  const N = inside.docs.length;
  const idf = (t: string) => {
    const df = inside.df.get(t) || 0;
    return { term: t, df, idf: Math.log(1 + (N - df + 0.5) / (df + 0.5)) };
  };
  const examples = ['زيت', 'زيتون', 'بكر', 'olive', 'عمان', 'الزرقاء'].map((t) => idf(normalize(t)));
  const sizes = {
    rows: ds.rows.length,
    entries: ds.entries.length,
    docs: docs.length,
    vectorBytes: docs.length * 256 * 4,
    vectorBase64: Math.ceil((docs.length * 256 * 4) / 3) * 4,
  };
  return {
    fileName: SEED_CSV_NAME,
    rawRows,
    headers,
    headerMap,
    sampleRaw,
    sampleClean,
    repeatedKeys: repeated,
    kept: ds.rows.length,
    meta: ds.meta,
    byType,
    docsByType,
    olive: { id: olive.id, name: olive.name, name_ar: olive.name_ar, aliases: olive.aliases, meta: olive.meta },
    oliveDocs,
    bm25: { N, avgLen: inside.avgLen, examples },
    charExample: charPieces('زيت زيتون'),
    sizes,
  };
}

// ---------- the character vector, piece by piece ----------
export function charPieces(text: string) {
  const toks = tokens(text).filter((t) => !isStopword(t));
  const words = toks.map((base) => {
    const stem = lightStem(base);
    const padded = `#${stem}#`;
    const pieces: { p: string; n: number; w: number; slot: number }[] = [];
    for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= padded.length; i++) {
      const p = padded.slice(i, i + n);
      pieces.push({ p, n, w: n - 1, slot: fnv1a(p) % 512 });
    }
    return { base, stem, padded, pieces };
  });
  const vec = Array.from(localVector(text));
  return { words, vec, nonzero: vec.filter((x) => x > 0).length };
}

// ---------- search, with every number shown ----------
export interface Cand {
  i: number;
  entryId: string;
  type: EntryType;
  alias: string;
  norm: string;
  toks: string[];
  bm: number;
  terms: { term: string; df: number; idf: number; part: number }[];
  fz: number;
  hitQ: number;
  hitD: number;
  rQ: number;
  pD: number;
  lex: number;
  exact: boolean;
  contained: boolean;
  covers: boolean;
  rBm: number;
  rFz: number;
  rrf: number;
  score: number;
  lexical: number;
  conf: number;
  rule: 'exact' | 'contained' | 'lexical';
}

export function searchDetail(mention: string, types: EntryType[], limit = 6) {
  const all = tokens(mention);
  const base = all.filter((t) => !isStopword(t));
  const removed = all.filter((t) => isStopword(t));
  const variants = base.map((t) => ({ token: t, variants: tokenVariants(t) }));
  const qVariants = new Set<string>();
  for (const t of base) for (const v of tokenVariants(t)) qVariants.add(v);
  const qToks = [...qVariants];
  const out = { mention, normalized: normalize(mention), tokens: all, base, removed, variants, types, cands: [] as Cand[], best: [] as Cand[], matches: [] as Match[], decision: decide([]), local: [] as number[] };
  if (!base.length) return out;
  const local = localVector(base.join(' '));
  out.local = Array.from(local);
  const N = inside.docs.length;
  const avg = inside.avgLen;
  const cands: Cand[] = [];
  for (let i = 0; i < N; i++) {
    const d = inside.docs[i];
    if (!types.includes(d.type)) continue;
    const dv = inside.docVariants[i];
    const len = d.toks.length || 1;
    const terms: Cand['terms'] = [];
    let bm = 0;
    for (const q of new Set(qToks)) {
      if (!dv.has(q)) continue;
      const df = inside.df.get(q) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const part = (idf * (1.2 + 1)) / (1 + 1.2 * (1 - 0.75 + (0.75 * len) / avg));
      terms.push({ term: q, df, idf, part });
      bm += part;
    }
    const fz = Math.max(0, cosine(local, inside.local[i]));
    if (bm === 0 && fz < 0.35) continue; // the engine skips these too (no Jina vector here)
    const hitQ = base.filter((t) => tokenVariants(t).some((v) => dv.has(v))).length;
    const hitD = d.toks.filter((t) => tokenVariants(t).some((v) => qVariants.has(v))).length;
    const rQ = hitQ / base.length;
    const pD = d.toks.length ? hitD / d.toks.length : 0;
    const lex = rQ + pD ? (2 * rQ * pD) / (rQ + pD) : 0;
    const exact = rQ === 1 && pD === 1;
    const contained = pD === 1 && hitD > 0;
    cands.push({ i, entryId: d.entryId, type: d.type, alias: d.text, norm: d.norm, toks: d.toks, bm, terms, fz, hitQ, hitD, rQ, pD, lex, exact, contained, covers: rQ === 1, rBm: 0, rFz: 0, rrf: 0, score: 0, lexical: 0, conf: 0, rule: 'lexical' });
  }
  const rankOf = (key: 'bm' | 'fz') => {
    const m = new Map<number, number>();
    [...cands].sort((a, b) => b[key] - a[key]).forEach((c, r) => m.set(c.i, r + 1));
    return m;
  };
  const rBm = rankOf('bm');
  const rFz = rankOf('fz');
  for (const c of cands) {
    c.rBm = rBm.get(c.i) || 999;
    c.rFz = rFz.get(c.i) || 999;
    c.rrf = 1 / (60 + c.rBm) + 1 / (60 + c.rFz);
    c.score = c.rrf + (c.exact ? 0.05 : 0);
    c.lexical = 0.55 * c.lex + 0.45 * c.fz;
    c.conf = Math.min(1, Math.max(c.exact ? 1 : 0, c.contained ? Math.max(c.lexical, 0.78) : c.lexical, 0));
    c.rule = c.exact ? 'exact' : c.contained && c.lexical < 0.78 ? 'contained' : 'lexical';
  }
  const byEntry = new Map<string, Cand>();
  for (const c of cands) {
    const prev = byEntry.get(c.entryId);
    if (!prev || c.conf > prev.conf || (c.conf === prev.conf && c.score > prev.score)) byEntry.set(c.entryId, c);
  }
  const best = [...byEntry.values()].sort((a, b) => b.conf - a.conf || b.score - a.score);
  const matches: Match[] = best.slice(0, limit).map((c) => ({
    entry: catalog.entries.get(c.entryId)!,
    conf: c.conf,
    score: c.score,
    alias: c.alias,
    how: { exact: c.exact, contained: c.contained, lexical: +c.lexical.toFixed(3), fuzzy: +c.fz.toFixed(3), semantic: null, covers: c.covers },
  }));
  out.cands = cands;
  out.best = best;
  out.matches = matches;
  out.decision = decide(matches);
  return out;
}

export function docVector(i: number): number[] {
  return Array.from(inside.local[i]);
}

export function entry(id: string) {
  return catalog.entries.get(id) || null;
}

// ---------- running the graphs ----------
interface SearchCall {
  node: string;
  mention: string;
  types: string[];
  matches: Match[];
  status: string;
}

function spyEngine(calls: SearchCall[], cur: { node: string }): SearchEngine {
  const spy = Object.create(engine) as SearchEngine;
  spy.search = async (mention: string, types: EntryType[], limit = 5, qVec?: Float32Array | null) => {
    const r = await engine.search(mention, types, limit, qVec);
    calls.push({ node: cur.node, mention, types, matches: r, status: decide(r).status });
    return r;
  };
  return spy;
}

function wrapNodes<S>(def: GraphDef<S>, cur: { node: string }, updates: { node: string; ms: number; out: Record<string, unknown> }[]) {
  for (const [name, fn] of Object.entries(def.nodes)) {
    def.nodes[name] = async (s: S) => {
      cur.node = name;
      const t0 = performance.now();
      const out = await fn(s);
      updates.push({ node: name, ms: performance.now() - t0, out: out as Record<string, unknown> });
      return out;
    };
  }
}

const livePosts = new Map<string, { post: PostRec; ctx: PostCtx | null }>();

export async function runAsk(input: { postId: string; text: string; personaId?: string; choice?: Choice | null }) {
  const live = livePosts.get(input.postId);
  const post = live?.post || seed.posts.find((p) => p.id === input.postId) || null;
  const ctx = live ? live.ctx : seed.ctxs.find((c) => c.post_id === input.postId) || null;
  const persona = PERSONAS.find((p) => p.id === (input.personaId || 'ahmad')) || PERSONAS[1];
  const comment: CommentRec = { id: 'c-explorer', post_id: input.postId, created_at: nowIso(), persona_id: persona.id, author_name: persona.name, author_handle: persona.handle, text: input.text };
  const calls: SearchCall[] = [];
  const cur = { node: '' };
  const deps: AskDeps = {
    catalog,
    engine: spyEngine(calls, cur),
    llm: null,
    loadComment: async () => comment,
    loadPost: async () => post,
    ensurePostContext: async () => ctx,
    today: nowIso().slice(0, 10),
  };
  const def = askGraphDef(deps);
  const updates: { node: string; ms: number; out: Record<string, unknown> }[] = [];
  wrapNodes(def, cur, updates);
  const graph = await compileGraph(def);
  const t0 = performance.now();
  const state = (await graph.invoke({ post_id: input.postId, comment_id: comment.id, choice: input.choice ?? null, products: [], answers: [], checks: [], clarify: null, place: null, reply: '', model: null, written_by: null, draft: null })) as AskState;
  const ms = performance.now() - t0;
  const draft = state.draft ? { ...state.draft, engine: graph.engine, trace: state.trace || [], notes: state.notes || [], ms: Math.round(ms) } : null;
  return { comment, post, ctx, persona, state, draft, updates, calls, engine: graph.engine, ms };
}

export async function runPost(caption: string) {
  const post: PostRec = { id: 'post-explorer', created_at: nowIso(), caption, image: '' };
  const calls: SearchCall[] = [];
  const cur = { node: '' };
  const deps: PostDeps = { catalog, engine: spyEngine(calls, cur), llm: null, loadPost: async () => post, loadImageDataUrl: async () => null };
  const def = postGraphDef(deps);
  const updates: { node: string; ms: number; out: Record<string, unknown> }[] = [];
  wrapNodes(def, cur, updates);
  const graph = await compileGraph(def);
  const state = (await graph.invoke({ post_id: post.id, spotted: [], linked: [], summary: '', image: null, ctx: null })) as PostState;
  const ctx: PostCtx | null = state.ctx ? { ...state.ctx, engine: graph.engine, trace: state.trace || [], notes: state.notes || [] } : null;
  livePosts.set(post.id, { post, ctx });
  return { post, state, ctx, updates, calls, engine: graph.engine };
}

// What Groq would be sent for this comment: the reading prompt, and the facts the writing prompt carries.
export function promptsOf(r: { state: AskState; comment: CommentRec; post: PostRec | null; ctx: PostCtx | null }) {
  const c = r.comment;
  const products = engine.allEntries('product').map((e) => `${e.name} (${e.name_ar})`);
  const places = [...engine.allEntries('city'), ...engine.allEntries('area')].map((e) => `${e.name} (${e.name_ar})`);
  const understand = understandPrompt({ caption: r.post?.caption || '', postProducts: (r.ctx?.products || []).map((x) => `${x.name} (${x.name_ar})`), name: c.author_name, comment: c.text, productHints: products, placeHints: places });
  const s = r.state;
  const u = s.understanding;
  let facts: unknown = null;
  let compose: { system: string; user: string } | null = null;
  if (u && s.answers && s.answers.length) {
    const lang = u.lang || (hasArabic(c.text) ? 'ar' : 'en');
    facts = factsFor(s.answers, { lang, name: firstName(c.author_name), wantsPrice: u.wants_price, priceOnly: u.intent === 'price', today: nowIso().slice(0, 10) });
    compose = composePrompt({ comment: c.text, facts, lang });
  }
  return { understand, facts, compose };
}

// The node and edge lists come from the same definitions the backend compiles.
function shape<S>(def: GraphDef<S>) {
  return { name: def.name, start: def.start, nodes: Object.keys(def.nodes), channels: def.channels, edges: def.edges, branches: def.branches.map((b) => ({ from: b.from, map: b.map })) };
}

export function graphShapes() {
  const noop = async () => null;
  const ask = askGraphDef({ catalog, engine, llm: null, loadComment: noop, loadPost: noop, ensurePostContext: noop, today: '' });
  const post = postGraphDef({ catalog, engine, llm: null, loadPost: noop, loadImageDataUrl: noop });
  return { ask: shape(ask), post: shape(post) };
}

export const sample = {
  posts: SEED_POSTS.map((p) => ({ id: p.id, caption: p.caption, products: p.products, summary: p.summary, comments: p.comments.map((c) => ({ id: c.id, persona: c.persona, text: c.text })) })),
  personas: PERSONAS,
};

export const stats = {
  rows: ds.rows.length,
  entries: ds.entries.length,
  docs: docs.length,
  products: ds.meta.products,
  stores: ds.meta.stores,
  dateMin: ds.meta.date_min,
  dateMax: ds.meta.date_max,
};

// For the build-time tests only.
export const _internals = { engine, catalog, ds, docs, seed };
