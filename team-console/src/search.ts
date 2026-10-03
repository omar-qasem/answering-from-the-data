// Hybrid search over the catalogs: BM25 on words + vectors, fused with Reciprocal Rank Fusion (RRF).
// It answers "which product / shop / area does this text mean?", never "where is it in stock" (that is the exact query).
// Vectors are AI embeddings (Jina by default, or Gemini or OpenAI) when a key is set, plus hashed character vectors that work offline and catch typos.
import type { Entry, EntryType } from './ingest';
import { fnv1a, isStopword, normalize, tokenVariants, tokens } from './text';

export interface AliasDoc {
  entryId: string;
  type: EntryType;
  text: string;
  norm: string;
  toks: string[]; // normalized tokens, no stopwords
}

export interface SemanticVectors {
  model: string; // the configured embedding model
  used?: string; // the model that actually made the vectors (queries must use the same one)
  cfgKey?: string; // provider:model:dims the index was built for
  dims: number;
  vecs: string[]; // base64 Float32, one per alias doc (same order)
}

export interface SearchIndexData {
  version: 1;
  docs: AliasDoc[];
  semantic?: SemanticVectors;
  built_at: string;
}

export interface Match {
  entry: Entry;
  conf: number; // 0..1
  score: number; // fused rank score
  alias: string;
  how: { exact: boolean; contained: boolean; lexical: number; fuzzy: number; semantic: number | null; covers: boolean }; // covers: every word of the mention is in the name
}

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

const LOCAL_DIMS = 512;

// Light stemming for the character vectors: drop "ال" and the prefixes glued to it (بال، وال، لل).
export function lightStem(tok: string): string {
  const m = tok.match(/^(?:و)?(?:[بلكف])?ال(.{2,})$/);
  if (m) return m[1];
  if (tok.startsWith('لل') && tok.length > 4) return tok.slice(2);
  return tok;
}

export function localVector(text: string): Float32Array {
  const v = new Float32Array(LOCAL_DIMS);
  const toks = tokens(text).filter((t) => !isStopword(t));
  for (const base of toks) {
    const t = `#${lightStem(base)}#`;
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= t.length; i++) {
        v[fnv1a(t.slice(i, i + n)) % LOCAL_DIMS] += n - 1;
      }
    }
  }
  return unit(v);
}

function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function vecToB64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

export function b64ToVec(s: string): Float32Array {
  const buf = Buffer.from(s, 'base64');
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

export function buildAliasDocs(entries: Entry[]): AliasDoc[] {
  const docs: AliasDoc[] = [];
  for (const e of entries) {
    const seen = new Set<string>();
    for (const a of [...e.aliases, e.name_ar]) {
      const norm = normalize(a);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      docs.push({ entryId: e.id, type: e.type, text: a, norm, toks: tokens(a).filter((t) => !isStopword(t)) });
    }
  }
  return docs;
}

function variantSet(toks: string[]): Set<string> {
  const s = new Set<string>();
  for (const t of toks) for (const v of tokenVariants(t)) s.add(v);
  return s;
}

export class SearchEngine {
  private entries = new Map<string, Entry>();
  private docs: AliasDoc[];
  private local: Float32Array[];
  private semantic: Float32Array[] | null;
  private semanticModel: string | null;
  private df = new Map<string, number>();
  private avgLen: number;
  private docVariants: Set<string>[];
  embed: EmbedFn | null;

  constructor(entries: Entry[], data: SearchIndexData, embed: EmbedFn | null) {
    for (const e of entries) this.entries.set(e.id, e);
    this.docs = data.docs.filter((d) => this.entries.has(d.entryId));
    const keep = new Set(this.docs);
    this.local = this.docs.map((d) => localVector(d.text));
    const sem = data.semantic;
    this.semantic = sem && sem.vecs.length === data.docs.length ? data.docs.map((d, i) => (keep.has(d) ? b64ToVec(sem.vecs[i]) : null)).filter((v): v is Float32Array => v !== null) : null;
    this.semanticModel = this.semantic ? sem!.model : null;
    this.embed = this.semantic ? embed : null;
    this.docVariants = this.docs.map((d) => variantSet(d.toks));
    for (const set of this.docVariants) for (const t of set) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.avgLen = this.docs.reduce((s, d) => s + d.toks.length, 0) / Math.max(1, this.docs.length);
  }

  get mode(): string {
    return this.semantic ? `hybrid: BM25 + AI vectors (${this.semanticModel}) + character vectors` : 'hybrid: BM25 + character vectors (offline)';
  }

  entry(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  allEntries(type?: EntryType): Entry[] {
    return [...this.entries.values()].filter((e) => !type || e.type === type);
  }

  private bm25(qToks: string[], i: number): number {
    const k1 = 1.2;
    const b = 0.75;
    const N = this.docs.length;
    const dv = this.docVariants[i];
    const len = this.docs[i].toks.length || 1;
    let s = 0;
    for (const q of new Set(qToks)) {
      if (!dv.has(q)) continue;
      const df = this.df.get(q) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      s += (idf * (k1 + 1)) / (1 + k1 * (1 - b + (b * len) / this.avgLen));
    }
    return s;
  }

  // Search one mention (a product name, an area, a shop...) inside the given entry types.
  async search(mention: string, types: EntryType[], limit = 5, qVec?: Float32Array | null): Promise<Match[]> {
    const base = tokens(mention).filter((t) => !isStopword(t));
    if (!base.length) return [];
    const qVariants = variantSet(base);
    const qToks = [...qVariants];
    const local = localVector(base.join(' '));
    // qVec: a vector already computed for this mention; null = do not call the embedding API for this search; undefined = embed it now
    let sem: Float32Array | null = qVec ?? null;
    if (qVec === undefined && this.semantic && this.embed) {
      try {
        const r = await this.embed([base.join(' ')]);
        sem = r?.[0] ?? null;
      } catch {
        sem = null;
      }
    }
    const cands: { i: number; bm: number; fz: number; se: number | null; lex: number; exact: boolean; contained: boolean; covers: boolean }[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      const d = this.docs[i];
      if (!types.includes(d.type)) continue;
      const bm = this.bm25(qToks, i);
      const fz = Math.max(0, cosine(local, this.local[i]));
      const se = sem && this.semantic ? Math.max(0, cosine(sem, this.semantic[i])) : null;
      if (bm === 0 && fz < 0.35 && (se === null || se < 0.45)) continue;
      // lexical overlap as an F1 between the mention's words and the alias's words (Arabic prefixes allowed)
      const dv = this.docVariants[i];
      const hitQ = base.filter((t) => tokenVariants(t).some((v) => dv.has(v))).length;
      const hitD = d.toks.filter((t) => tokenVariants(t).some((v) => qVariants.has(v))).length;
      const rQ = hitQ / base.length;
      const pD = d.toks.length ? hitD / d.toks.length : 0;
      const lex = rQ + pD ? (2 * rQ * pD) / (rQ + pD) : 0;
      const exact = rQ === 1 && pD === 1;
      const contained = pD === 1 && hitD > 0; // the whole alias appears in the text
      cands.push({ i, bm, fz, se, lex, exact, contained, covers: rQ === 1 });
    }
    if (!cands.length) return [];
    const rankOf = (key: 'bm' | 'fz' | 'se') => {
      const sorted = [...cands].filter((c) => c[key] !== null).sort((a, b) => (b[key] as number) - (a[key] as number));
      const m = new Map<number, number>();
      sorted.forEach((c, r) => m.set(c.i, r + 1));
      return m;
    };
    const rBm = rankOf('bm');
    const rFz = rankOf('fz');
    const rSe = this.semantic && sem ? rankOf('se') : null;
    const byEntry = new Map<string, Match>();
    for (const c of cands) {
      const d = this.docs[c.i];
      let score = 1 / (60 + (rBm.get(c.i) || 999)) + 1 / (60 + (rFz.get(c.i) || 999));
      if (rSe) score += 1 / (60 + (rSe.get(c.i) || 999));
      if (c.exact) score += 0.05;
      const lexical = 0.55 * c.lex + 0.45 * c.fz;
      const semConf = c.se === null ? 0 : Math.max(0, Math.min(1, (c.se - 0.35) / 0.4)) * 0.9;
      const conf = Math.min(1, Math.max(c.exact ? 1 : 0, c.contained ? Math.max(lexical, 0.78) : lexical, semConf));
      const prev = byEntry.get(d.entryId);
      if (!prev || conf > prev.conf || (conf === prev.conf && score > prev.score)) {
        byEntry.set(d.entryId, {
          entry: this.entries.get(d.entryId)!,
          conf,
          score,
          alias: d.text,
          how: { exact: c.exact, contained: c.contained, lexical: +lexical.toFixed(3), fuzzy: +c.fz.toFixed(3), semantic: c.se === null ? null : +c.se.toFixed(3), covers: c.covers },
        });
      }
    }
    return [...byEntry.values()].sort((a, b) => b.conf - a.conf || b.score - a.score).slice(0, limit);
  }

  // Embed many mentions in one call (fewer round trips to the embedding API).
  async embedMany(texts: string[]): Promise<(Float32Array | null)[]> {
    if (!this.semantic || !this.embed || !texts.length) return texts.map(() => null);
    try {
      const r = await this.embed(texts.map((t) => tokens(t).filter((x) => !isStopword(x)).join(' ') || t));
      return r ?? texts.map(() => null);
    } catch {
      return texts.map(() => null);
    }
  }
}

export type Decision = { status: 'match'; match: Match; alternatives: Match[] } | { status: 'ambiguous'; options: Match[] } | { status: 'none'; best?: Match };

export const ACCEPT = 0.72;
export const CONSIDER = 0.55;
export const MARGIN = 0.08;

export function decide(matches: Match[]): Decision {
  if (!matches.length || matches[0].conf < CONSIDER) return { status: 'none', best: matches[0] };
  const top = matches[0];
  // close calls: a similar score, or (when the top is not an exact name) another name that contains every word
  // of the mention just as well ("رز" is in "رز مصري" and in "رز بسمتي") — vectors must not break that tie
  const close = matches.filter(
    (m) =>
      m !== top &&
      m.entry.type === top.entry.type &&
      !(top.how.exact && !m.how.exact) &&
      (m.conf >= top.conf - MARGIN || (!top.how.exact && top.how.covers && m.how.covers && m.conf >= CONSIDER)),
  );
  if (top.conf >= ACCEPT && !close.length) return { status: 'match', match: top, alternatives: matches.slice(1, 4) };
  const options = top.conf >= ACCEPT ? [top, ...close] : matches.filter((m) => m.entry.type === top.entry.type && m.conf >= CONSIDER);
  return { status: 'ambiguous', options: options.slice(0, 5) };
}
