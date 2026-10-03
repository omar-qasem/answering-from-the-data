// What the API functions call: data upload and index, posts, comments, drafting, replies, reset and health.
import { runAsk, type AskDeps, type Choice } from './graphs/ask';
import { runPost } from './graphs/post';
import { graphEngineError, loadLangGraph } from './graphs/runtime';
import { buildDataset, IngestError, type DatasetMeta, type Entry, type Row } from './ingest';
import { embedConfig, llmConfig, makeClient, makeEmbedder, providerName, type EmbedClient, type EmbedConfig, type LlmClient, type LlmConfig } from './llm';
import { Catalog } from './query';
import { daysBetween } from './reply';
import { SearchEngine, buildAliasDocs, vecToB64, type SearchIndexData } from './search';
import { BRAND, PERSONAS, seedRecords } from './seed';
import { SEED_CSV, SEED_CSV_NAME } from './seed-csv';
import { openStores, type KV, type Stores } from './store';
import { clip, fnv1a, uid } from './text';
import type { BeatRec, CommentBeat, CommentRec, DraftRec, PostCtx, PostProduct, PostRec, ReplyRec } from './types';

export const APP_VERSION = '1.0.0';

export class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const LIMITS = { comment: 300, caption: 1200, imageBytes: 3_000_000, posts: 40, commentsPerPost: 80, comments: 600, reply: 1000, csvBytes: 4_500_000 };

export type DatasetInfo = DatasetMeta & {
  index_mode: 'words+characters' | 'words+characters+ai' | 'words+characters+openai'; // the last one is from older builds
  embed_model: string | null;
  embed_tried?: { model: string; at: string; ok: boolean; error?: string };
  version: number;
  sample: boolean;
};
const hasAiVectors = (m: DatasetInfo | null) => !!m && m.index_mode !== 'words+characters';

interface StoredDataset {
  meta: DatasetInfo;
  rows: Row[];
  entries: Entry[];
  index: SearchIndexData;
}

interface Bundle {
  stamp: string;
  catalog: Catalog;
  engine: SearchEngine;
  meta: DatasetInfo;
  semanticOff: string | null;
  embedModel: string | null; // the model that made the index vectors, if they are in use
}

let bundleCache: Bundle | null = null;
const jsonCache = new Map<string, { etag: string; value: unknown }>();

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Pending {
  post_id: string;
  comment_id: string;
}

export class App {
  readonly stores: Stores;
  readonly llm: LlmClient | null; // chat model: reads comments, writes replies
  readonly llmCfg: LlmConfig | null;
  readonly embedder: EmbedClient | null; // embedding model: vectors for the hybrid search
  readonly embedCfg: EmbedConfig | null;
  readonly background: boolean; // inside a background job: wait out rate limits instead of falling back at once
  private waitNote: BeatRec['wait'] = null;
  private beatNow: (() => void) | null = null;

  constructor(stores: Stores, llmCfg: LlmConfig | null, embedCfg: EmbedConfig | null = null, opts: { background?: boolean } = {}) {
    this.stores = stores;
    this.background = !!opts.background;
    this.llmCfg = llmCfg;
    const onWait = (ms: number, why: string) => {
      this.waitNote = { until: new Date(Date.now() + ms).toISOString(), why };
      this.beatNow?.();
    };
    // a background function is stopped after 15 minutes: AI calls never wait past 14
    const deadline = this.background ? Date.now() + 14 * 60000 : undefined;
    this.llm = llmCfg ? makeClient(llmCfg, { patient: this.background, deadline, onWait }) : null;
    this.embedCfg = embedCfg;
    this.embedder = embedCfg ? makeEmbedder(embedCfg, { patient: this.background, deadline }) : null;
  }

  static async open(opts: { background?: boolean } = {}): Promise<App> {
    const chat = llmConfig();
    return new App(await openStores(), chat, embedConfig(process.env, chat), opts);
  }

  // How many drafts one background job runs at once: one for Groq's free tier (8,000 tokens a minute), four otherwise.
  get concurrency(): number {
    const n = Math.floor(Number(process.env.AI_CONCURRENCY));
    if (n >= 1) return Math.min(8, n);
    return this.llmCfg?.provider === 'groq' ? 1 : 4;
  }

  private get embedKey(): string | null {
    return this.embedCfg ? `${this.embedCfg.provider}:${this.embedCfg.model}:${this.embedCfg.dims}` : null;
  }

  private get social(): KV {
    return this.stores.social;
  }

  // ---------- the availability data ----------
  private async buildStored(csv: string, fileName: string, sample: boolean): Promise<StoredDataset> {
    const ds = buildDataset(csv, fileName, nowIso());
    const docs = buildAliasDocs(ds.entries);
    const index: SearchIndexData = { version: 1, docs, built_at: nowIso() };
    let mode: DatasetInfo['index_mode'] = 'words+characters';
    let tried: DatasetInfo['embed_tried'];
    if (this.embedder && this.embedCfg) {
      try {
        const r = await this.embedder.embed(docs.map((d) => d.text));
        index.semantic = { model: this.embedCfg.model, used: r.model, cfgKey: this.embedKey!, dims: r.vecs[0]?.length || this.embedCfg.dims, vecs: r.vecs.map(vecToB64) };
        mode = 'words+characters+ai';
        tried = { model: this.embedKey!, at: nowIso(), ok: true };
      } catch (e) {
        tried = { model: this.embedKey!, at: nowIso(), ok: false, error: (e as Error).message };
        ds.meta.warnings.push(`${providerName(this.embedCfg.provider)} embeddings failed (${(e as Error).message}); search uses words and character vectors only. It tries again on its own after 15 minutes, or use "Rebuild index".`);
      }
    }
    return { meta: { ...ds.meta, index_mode: mode, embed_model: index.semantic?.cfgKey ?? null, embed_tried: tried, version: Date.now(), sample }, rows: ds.rows, entries: ds.entries, index };
  }

  private async saveStored(stored: StoredDataset, csv: string) {
    await this.stores.catalog.setJSON('dataset', stored);
    await this.stores.catalog.setJSON('dataset-csv', { file_name: stored.meta.file_name, csv });
    await this.stores.catalog.setJSON('dataset-meta', stored.meta);
    bundleCache = null;
  }

  async datasetMeta(): Promise<DatasetInfo | null> {
    return this.stores.catalog.getJSON<DatasetInfo>('dataset-meta');
  }

  async ensureDataset(): Promise<DatasetInfo> {
    const meta = await this.datasetMeta();
    if (meta) return meta;
    const stored = await this.buildStored(SEED_CSV, SEED_CSV_NAME, true);
    await this.saveStored(stored, SEED_CSV);
    return stored.meta;
  }

  // A key was added (or the embedding model changed) since the index was built: rebuild it once with AI vectors.
  // A failed attempt is not retried for 15 minutes, so a quota problem never slows every request.
  private needsAiVectors(meta: DatasetInfo): boolean {
    const want = this.embedKey;
    if (!want || meta.embed_model === want) return false;
    const t = meta.embed_tried;
    return !(t && t.model === want && Date.now() - Date.parse(t.at) < 15 * 60000);
  }

  async bundle(opts: { upgrade?: boolean } = {}): Promise<Bundle> {
    let meta = await this.ensureDataset();
    if (opts.upgrade !== false && this.needsAiVectors(meta)) {
      try {
        meta = await this.reindex();
      } catch {
        /* keep the current index */
      }
    }
    const stamp = `${meta.version}|${this.embedKey || ''}`;
    if (bundleCache && bundleCache.stamp === stamp) return bundleCache;
    const stored = await this.stores.catalog.getJSON<StoredDataset>('dataset');
    if (!stored) throw new HttpError(500, 'The data file is missing. Upload the CSV again on the Data page.');
    let index = stored.index;
    let semanticOff: string | null = null;
    const built = index.semantic ? index.semantic.cfgKey || `?:${index.semantic.model}` : null;
    if (index.semantic && (!this.embedKey || built !== this.embedKey)) {
      semanticOff = this.embedKey ? 'The index was built with another embedding model. Rebuild the index to use AI vectors.' : 'No embedding key: search runs on words and character vectors.';
      index = { ...index, semantic: undefined };
    }
    const queryModel = index.semantic ? index.semantic.used || index.semantic.model : undefined;
    const engine = new SearchEngine(stored.entries, index, this.embedder ? async (texts) => (await this.embedder!.embed(texts, queryModel)).vecs : null);
    bundleCache = { stamp, catalog: new Catalog(stored), engine, meta: stored.meta, semanticOff, embedModel: queryModel || null };
    return bundleCache;
  }

  async uploadData(fileName: string, csv: string): Promise<DatasetInfo> {
    if (!csv || !csv.trim()) throw new HttpError(400, 'The file is empty.');
    if (csv.length > LIMITS.csvBytes) throw new HttpError(413, 'The file is too large (max about 4 MB).');
    try {
      const stored = await this.buildStored(csv, clip(fileName || 'upload.csv', 120), false);
      await this.saveStored(stored, csv);
      return stored.meta;
    } catch (e) {
      if (e instanceof IngestError) throw new HttpError(422, 'The file could not be read.', { problems: e.problems });
      throw e;
    }
  }

  async reindex(): Promise<DatasetInfo> {
    const raw = await this.stores.catalog.getJSON<{ file_name: string; csv: string }>('dataset-csv');
    if (!raw) throw new HttpError(404, 'No data file to rebuild from.');
    const prev = await this.datasetMeta();
    const stored = await this.buildStored(raw.csv, raw.file_name, prev?.sample ?? false);
    await this.saveStored(stored, raw.csv);
    return stored.meta;
  }

  async restoreSample(): Promise<DatasetInfo> {
    const stored = await this.buildStored(SEED_CSV, SEED_CSV_NAME, true);
    await this.saveStored(stored, SEED_CSV);
    return stored.meta;
  }

  // ---------- social records ----------
  private async getCached<T>(key: string, etag: string): Promise<T | null> {
    const c = jsonCache.get(key);
    if (c && etag && c.etag === etag) return c.value as T;
    const v = await this.social.getJSON<T>(key);
    if (v !== null && etag) jsonCache.set(key, { etag, value: v });
    return v;
  }

  async loadPost(postId: string): Promise<PostRec | null> {
    return this.social.getJSON<PostRec>(`posts/${postId}`);
  }

  async loadComment(postId: string, commentId: string): Promise<CommentRec | null> {
    return this.social.getJSON<CommentRec>(`comments/${postId}/${commentId}`);
  }

  async ensureSeeded(): Promise<{ seeded: boolean; at: string | null; pending: Pending[] }> {
    const m = await this.social.getJSON('meta/seeded');
    if (m) return { seeded: false, at: null, pending: [] };
    return { seeded: true, ...(await this.seed()) };
  }

  // Writes the demo posts and comments. Comments marked "answered" get a reply built from the data (no AI).
  // Returns the comments that still need a draft, and the seed time that a background batch checks against.
  private async seed(): Promise<{ at: string; pending: Pending[] }> {
    const { posts, ctxs, comments, answered } = seedRecords();
    await Promise.all([
      ...posts.map((p) => this.social.setJSON(`posts/${p.id}`, p)),
      ...ctxs.map((c) => this.social.setJSON(`postctx/${c.post_id}`, c)),
      ...comments.map((c) => this.social.setJSON(`comments/${c.post_id}/${c.id}`, c)),
    ]);
    const answeredIds = new Set(answered.map((c) => c.id));
    for (const c of answered) {
      const { draft } = await this.runDraft(c.post_id, c.id, null, false);
      if (draft) {
        const at = new Date(Math.min(Date.now() - 30000, Date.parse(c.created_at) + 40 * 60000)).toISOString();
        await this.social.setJSON(`replies/${c.id}`, { comment_id: c.id, post_id: c.post_id, text: draft.text, at, by: 'seed', edited: false } satisfies ReplyRec);
        await this.social.setJSON(`drafts/${c.id}`, draft);
      }
    }
    const pending = comments.filter((c) => !answeredIds.has(c.id));
    const at = nowIso();
    if (!this.llm) {
      // without AI the drafts take milliseconds, so they are ready right away
      for (const c of pending) await this.draft(c.post_id, c.id, null);
      await this.social.setJSON('meta/seeded', { at, version: APP_VERSION });
      return { at, pending: [] };
    }
    await Promise.all(pending.map((c) => this.social.setJSON(`drafts/${c.id}`, this.placeholder(c.post_id, c.id))));
    await this.social.setJSON('meta/seeded', { at, version: APP_VERSION });
    return { at, pending: pending.map((c) => ({ post_id: c.post_id, comment_id: c.id })) };
  }

  async reset(): Promise<{ at: string; pending: Pending[] }> {
    const keys = await this.social.list();
    for (let i = 0; i < keys.length; i += 25) await Promise.all(keys.slice(i, i + 25).map((k) => this.social.delete(k.key)));
    const media = await this.stores.media.list();
    for (let i = 0; i < media.length; i += 25) await Promise.all(media.slice(i, i + 25).map((k) => this.stores.media.delete(k.key)));
    jsonCache.clear();
    return this.seed();
  }

  // ---------- the state both pages poll ----------
  async state(view: 'feed' | 'team', since?: string | null) {
    const listed = await this.social.list();
    const keys = view === 'team' ? listed : listed.filter((k) => !k.key.startsWith('beats/'));
    const meta = view === 'team' ? await this.datasetMeta() : null;
    const version = fnv1a(keys.map((k) => `${k.key}:${k.etag}`).join('|') + (meta ? `|${meta.version}` : '')).toString(36);
    if (since && since === version) return { unchanged: true, version, now: nowIso() };
    const group = (prefix: string) => keys.filter((k) => k.key.startsWith(prefix));
    const load = <T>(list: { key: string; etag: string }[]) => Promise.all(list.map((k) => this.getCached<T>(k.key, k.etag)));
    const beatKeys = view === 'team' ? group('beats/') : [];
    const [posts, ctxs, comments, drafts, replies, beats] = await Promise.all([
      load<PostRec>(group('posts/')),
      view === 'team' ? load<PostCtx>(group('postctx/')) : Promise.resolve([] as (PostCtx | null)[]),
      load<CommentRec>(group('comments/')),
      view === 'team' ? load<DraftRec>(group('drafts/')) : Promise.resolve([] as (DraftRec | null)[]),
      load<ReplyRec>(group('replies/')),
      load<BeatRec>(beatKeys),
    ]);
    // which comments a background job is holding (running or queued); beats of jobs gone for 20 minutes are removed
    const beatBy = new Map<string, CommentBeat>();
    const putBeat = (id: string, v: CommentBeat) => {
      const prev = beatBy.get(id);
      if (!prev || prev.at < v.at) beatBy.set(id, v);
    };
    beats.forEach((b, i) => {
      if (!b) return;
      if (Date.now() - Date.parse(b.at) > 20 * 60000) {
        this.social.delete(beatKeys[i].key).catch(() => {});
        return;
      }
      const queued = b.queued || [];
      (b.running || []).forEach((id) => putBeat(id, { at: b.at, state: 'running', pos: 0, of: queued.length, wait: b.wait || null }));
      queued.forEach((id, j) => putBeat(id, { at: b.at, state: 'queued', pos: j + 1, of: queued.length, wait: b.wait || null }));
    });
    const ctxBy = new Map(ctxs.filter(Boolean).map((c) => [c!.post_id, c!]));
    const draftBy = new Map(drafts.filter(Boolean).map((d) => [d!.comment_id, d!]));
    const replyBy = new Map(replies.filter(Boolean).map((r) => [r!.comment_id, r!]));
    const byPost = new Map<string, CommentRec[]>();
    for (const c of comments) {
      if (!c) continue;
      if (!byPost.has(c.post_id)) byPost.set(c.post_id, []);
      byPost.get(c.post_id)!.push(c);
    }
    const out = posts
      .filter((p): p is PostRec => !!p)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((p) => ({
        ...p,
        ...(view === 'team' ? { ctx: ctxBy.get(p.id) || null, beat: beatBy.get(`post:${p.id}`) || null } : {}),
        comments: (byPost.get(p.id) || [])
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((c) => {
            const r = replyBy.get(c.id);
            if (view === 'feed') return { ...c, reply: r && !r.dismissed ? { text: r.text, at: r.at } : null };
            return { ...c, reply: r || null, draft: draftBy.get(c.id) || null, beat: beatBy.get(c.id) || null };
          }),
      }));
    return {
      version,
      now: nowIso(),
      brand: BRAND,
      personas: PERSONAS,
      posts: out,
      ...(view === 'team' ? { data: meta, today: nowIso().slice(0, 10) } : {}),
    };
  }

  // ---------- posts ----------
  async createPost(input: { caption?: string; image?: string }): Promise<PostRec> {
    const caption = clip(String(input.caption || ''), LIMITS.caption);
    const m = String(input.image || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new HttpError(400, 'Add an image (JPEG, PNG or WebP).');
    const bytes = Uint8Array.from(Buffer.from(m[2], 'base64'));
    if (bytes.byteLength > LIMITS.imageBytes) throw new HttpError(413, 'The image is too large.');
    const count = (await this.social.list('posts/')).length;
    if (count >= LIMITS.posts) throw new HttpError(429, 'The demo is full. Reset it from the team page.');
    const id = uid('post');
    await this.stores.media.setBytes(`img/${id}`, bytes, m[1]);
    const post: PostRec = { id, created_at: nowIso(), caption, image: `/api/media/${id}` };
    await this.social.setJSON(`postctx/${id}`, { post_id: id, status: 'pending', products: [], summary: '', by: 'rules', analyzed_at: nowIso() } satisfies PostCtx);
    await this.social.setJSON(`posts/${id}`, post);
    return post;
  }

  async media(id: string): Promise<{ data: Uint8Array; type: string } | null> {
    if (!/^[a-z0-9_]+$/i.test(id)) return null;
    return this.stores.media.getBytes(`img/${id}`);
  }

  private async imageDataUrl(post: PostRec): Promise<string | null> {
    if (post.image.startsWith('/api/media/')) {
      const img = await this.media(post.image.split('/').pop()!);
      return img ? `data:${img.type};base64,${Buffer.from(img.data).toString('base64')}` : null;
    }
    const site = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
    return /^https:\/\//.test(site) ? `${site.replace(/\/$/, '')}${post.image}` : null;
  }

  async analyzePost(postId: string): Promise<PostCtx> {
    const b = await this.bundle();
    const ctx = await runPost({ catalog: b.catalog, engine: b.engine, llm: this.llm, loadPost: (id) => this.loadPost(id), loadImageDataUrl: (p) => this.imageDataUrl(p) }, postId);
    if (!ctx) throw new HttpError(404, 'Post not found.');
    await this.social.setJSON(`postctx/${postId}`, ctx);
    return ctx;
  }

  async ensurePostContext(postId: string): Promise<PostCtx | null> {
    const ctx = await this.social.getJSON<PostCtx>(`postctx/${postId}`);
    if (ctx && ctx.status === 'done') return ctx;
    const fresh = this.background ? 120000 : 20000;
    if (ctx && ctx.status === 'pending' && Date.now() - Date.parse(ctx.analyzed_at) < fresh && this.llm) {
      // the post analysis is probably running in the background right now (perhaps waiting out a rate limit); wait for it
      for (let i = 0; i < (this.background ? 60 : 8); i++) {
        await sleep(1500);
        const again = await this.social.getJSON<PostCtx>(`postctx/${postId}`);
        if (again && again.status === 'done') return again;
      }
    }
    try {
      return await this.analyzePost(postId);
    } catch {
      return ctx;
    }
  }

  async setPostProducts(postId: string, ids: string[]): Promise<PostCtx> {
    const b = await this.bundle();
    const post = await this.loadPost(postId);
    if (!post) throw new HttpError(404, 'Post not found.');
    const products: PostProduct[] = [];
    for (const id of [...new Set(ids)].slice(0, 6)) {
      const e = b.catalog.entries.get(id);
      if (!e || e.type !== 'product') throw new HttpError(400, `Unknown product: ${id}`);
      products.push({ id: e.id, name: e.name, name_ar: e.name_ar, pack: null, source: 'team', conf: 1 });
    }
    const prev = await this.social.getJSON<PostCtx>(`postctx/${postId}`);
    const ctx: PostCtx = { post_id: postId, status: 'done', products, summary: prev?.summary || '', by: 'team', analyzed_at: nowIso(), notes: ['Products set by the team.'] };
    await this.social.setJSON(`postctx/${postId}`, ctx);
    return ctx;
  }

  // ---------- comments and drafts ----------
  placeholder(postId: string, commentId: string): DraftRec {
    return { comment_id: commentId, post_id: postId, status: 'drafting', kind: 'none', text: '', lang: 'ar', intent: null, understood_by: null, written_by: null, engine: null, model: null, products: [], place: null, scope_note: null, pack: null, basis: [], options: null, checks: [], notes: [], trace: [], reason: '', created_at: nowIso(), started_at: nowIso(), ms: 0 };
  }

  // No background job could be started: flag the waiting draft (or post analysis) so the team page does it right away.
  async markForPage(postId: string, commentId?: string): Promise<void> {
    if (commentId) {
      const d = await this.social.getJSON<DraftRec>(`drafts/${commentId}`);
      if (d && d.status === 'drafting') await this.social.setJSON(`drafts/${commentId}`, { ...d, via: 'page' });
      return;
    }
    const c = await this.social.getJSON<PostCtx>(`postctx/${postId}`);
    if (c && c.status === 'pending') await this.social.setJSON(`postctx/${postId}`, { ...c, via: 'page' });
  }

  async createComment(input: { post_id?: string; persona_id?: string; text?: string }): Promise<CommentRec> {
    const text = clip(String(input.text || ''), LIMITS.comment);
    if (!text) throw new HttpError(400, 'Write a comment first.');
    const persona = PERSONAS.find((p) => p.id === input.persona_id);
    if (!persona) throw new HttpError(400, 'Pick who is commenting.');
    const postId = String(input.post_id || '');
    const post = await this.loadPost(postId);
    if (!post) throw new HttpError(404, 'That post no longer exists.');
    const all = await this.social.list('comments/');
    if (all.length >= LIMITS.comments || all.filter((k) => k.key.startsWith(`comments/${postId}/`)).length >= LIMITS.commentsPerPost) throw new HttpError(429, 'The demo is full. Reset it from the team page.');
    const c: CommentRec = { id: uid('c'), post_id: postId, created_at: nowIso(), persona_id: persona.id, author_name: persona.name, author_handle: persona.handle, text };
    await this.social.setJSON(`drafts/${c.id}`, this.placeholder(postId, c.id));
    await this.social.setJSON(`comments/${postId}/${c.id}`, c);
    return c;
  }

  private async runDraft(postId: string, commentId: string, choice: Choice | null, useAI: boolean) {
    const b = await this.bundle();
    const deps: AskDeps = {
      catalog: b.catalog,
      engine: b.engine,
      llm: useAI ? this.llm : null,
      loadComment: (p, c) => this.loadComment(p, c),
      loadPost: (p) => this.loadPost(p),
      ensurePostContext: (p) => this.ensurePostContext(p),
      today: nowIso().slice(0, 10),
    };
    return runAsk(deps, { post_id: postId, comment_id: commentId, choice });
  }

  async draft(postId: string, commentId: string, choice: Choice | null = null): Promise<DraftRec> {
    try {
      const { draft } = await this.runDraft(postId, commentId, choice, true);
      if (!draft) throw new HttpError(404, 'Comment not found.');
      await this.social.setJSON(`drafts/${commentId}`, draft);
      return draft;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw e;
      const failed: DraftRec = { ...this.placeholder(postId, commentId), status: 'failed', error: (e as Error).message || String(e) };
      await this.social.setJSON(`drafts/${commentId}`, failed);
      return failed;
    }
  }

  // ---------- background jobs ----------
  // While a job works it writes beats/<job id> every 20 seconds (and whenever it starts waiting out a rate limit),
  // so the team page leaves its drafts alone and shows which comment is being drafted and which are waiting.
  private async withBeat<T>(running: () => string[], queued: () => string[], fn: () => Promise<T>): Promise<T> {
    const key = `beats/${uid('job')}`;
    let chain: Promise<void> = Promise.resolve();
    const beat = (): BeatRec => ({ at: nowIso(), running: running(), queued: queued(), wait: this.waitNote && Date.parse(this.waitNote.until) > Date.now() ? this.waitNote : null });
    const write = () => {
      chain = chain.then(() => this.social.setJSON(key, beat()).catch(() => {}));
    };
    write();
    this.beatNow = write;
    const timer = setInterval(write, 20000);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      this.beatNow = null;
      await chain;
      await this.social.delete(key).catch(() => {});
    }
  }

  // A new post: find its products in a background job.
  async analyzeInBackground(postId: string): Promise<void> {
    await this.withBeat(
      () => [`post:${postId}`],
      () => [],
      async () => {
        await this.analyzePost(postId).catch(async (e) => {
          await this.social.setJSON(`postctx/${postId}`, { post_id: postId, status: 'failed', products: [], summary: '', by: 'rules', analyzed_at: nowIso(), error: (e as Error).message } satisfies PostCtx);
        });
      },
    );
  }

  // One new comment (from the feed): draft it in a background job.
  async draftInBackground(postId: string, commentId: string, choice: Choice | null = null): Promise<void> {
    let done = false;
    await this.withBeat(
      () => (done ? [] : [commentId]),
      () => [],
      async () => {
        await this.draft(postId, commentId, choice).catch(() => null);
        done = true;
      },
    );
  }

  // The demo's starting comments: one job drafts them a few at a time (one at a time on Groq's free tier),
  // waiting out the AI model's rate limits. It stops if the demo was reset meanwhile. Close to the 15-minute
  // limit of a background function it hands the rest to a fresh job, or else to the team page.
  async draftBatch(items: Pending[], opts: { seededAt?: string | null; handOff?: (rest: Pending[]) => Promise<boolean>; budgetMs?: number } = {}): Promise<{ drafted: number; left: number }> {
    const t0 = Date.now();
    const budget = opts.budgetMs ?? 11 * 60000; // no new comment after 11 minutes; the last one has until the 14-minute deadline
    const queue = (Array.isArray(items) ? items : []).filter((x) => x && typeof x.post_id === 'string' && typeof x.comment_id === 'string').slice(0, LIMITS.comments);
    const running = new Set<string>();
    let drafted = 0;
    let stale = false;
    await this.withBeat(
      () => [...running],
      () => queue.map((x) => x.comment_id),
      async () => {
        const worker = async () => {
          while (queue.length && !stale && Date.now() - t0 < budget) {
            if (opts.seededAt) {
              const m = await this.social.getJSON<{ at: string }>('meta/seeded');
              if (!m || m.at !== opts.seededAt) {
                stale = true; // the demo was reset: a newer job owns these comments now
                break;
              }
            }
            const it = queue.shift()!;
            const cur = await this.social.getJSON<DraftRec>(`drafts/${it.comment_id}`);
            if (cur && cur.status !== 'drafting') continue; // already drafted, for example by the team page
            running.add(it.comment_id);
            try {
              await this.draft(it.post_id, it.comment_id, null);
              drafted++;
            } catch {
              /* the comment is gone */
            } finally {
              running.delete(it.comment_id);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(this.concurrency, queue.length)) }, worker));
      },
    );
    if (stale) return { drafted, left: 0 };
    const left = queue.splice(0);
    if (left.length && !(opts.handOff && (await opts.handOff(left).catch(() => false)))) await Promise.all(left.map((x) => this.markForPage(x.post_id, x.comment_id)));
    return { drafted, left: left.length };
  }

  async reply(input: { post_id?: string; comment_id?: string; action?: string; text?: string }): Promise<ReplyRec | null> {
    const postId = String(input.post_id || '');
    const commentId = String(input.comment_id || '');
    const c = await this.loadComment(postId, commentId);
    if (!c) throw new HttpError(404, 'Comment not found.');
    const key = `replies/${commentId}`;
    if (input.action === 'undo') {
      await this.social.delete(key);
      return null;
    }
    if (input.action === 'dismiss') {
      const r: ReplyRec = { comment_id: commentId, post_id: postId, text: '', at: nowIso(), by: 'team', edited: false, dismissed: true };
      await this.social.setJSON(key, r);
      return r;
    }
    const text = String(input.text || '').trim();
    if (!text) throw new HttpError(400, 'The reply is empty.');
    if (text.length > LIMITS.reply) throw new HttpError(400, 'The reply is too long.');
    const d = await this.social.getJSON<DraftRec>(`drafts/${commentId}`);
    const r: ReplyRec = { comment_id: commentId, post_id: postId, text, at: nowIso(), by: 'team', edited: !d || d.text.trim() !== text };
    await this.social.setJSON(key, r);
    return r;
  }

  // ---------- health ----------
  async health() {
    const lg = await loadLangGraph();
    const meta = await this.datasetMeta().catch(() => null);
    const b = meta ? await this.bundle({ upgrade: false }).catch(() => null) : null;
    const today = nowIso().slice(0, 10);
    return {
      ok: true,
      version: APP_VERSION,
      time: nowIso(),
      storage: this.stores.kind,
      engine: lg.mod ? 'langgraph' : 'built-in',
      engine_note: lg.mod ? graphEngineError() : lg.error,
      ai: this.llmCfg
        ? { enabled: true, provider: this.llmCfg.provider, provider_name: providerName(this.llmCfg.provider), model: this.llmCfg.model, vision: !!this.llm?.vision, max_tokens: this.llmCfg.maxOut ?? null, concurrency: this.concurrency }
        : { enabled: false, provider: null, provider_name: null, model: null, vision: false, max_tokens: null, concurrency: 0 },
      embeddings: this.embedCfg
        ? { enabled: true, provider: this.embedCfg.provider, provider_name: providerName(this.embedCfg.provider), model: b && b.embedModel ? this.embedUsed(b) : this.embedCfg.model }
        : { enabled: false, provider: null, provider_name: null, model: null },
      search: meta ? (b?.semanticOff || !hasAiVectors(meta) ? 'words+characters' : 'words+characters+ai') : null,
      search_note: b?.semanticOff || null,
      data: meta
        ? { file_name: meta.file_name, sample: meta.sample, rows: meta.row_count, stores: meta.stores, products: meta.products, cities: meta.cities, date_min: meta.date_min, date_max: meta.date_max, uploaded_at: meta.uploaded_at, age_days: daysBetween(meta.date_max, today), warnings: meta.warnings }
        : null,
      passcode: !!process.env.TEAM_PASSCODE,
      feed_url: process.env.FEED_URL || null,
    };
  }

  private embedUsed(b: Bundle): string {
    return b.embedModel || this.embedCfg?.model || '';
  }

  // One tiny call to each configured model, so the team can see the keys work.
  async aiCheck(): Promise<{ ok: boolean; model: string | null; ms: number; error?: string; embeddings?: { ok: boolean; model: string | null; error?: string } }> {
    let emb: { ok: boolean; model: string | null; error?: string } | undefined;
    if (this.embedder) {
      try {
        const r = await this.embedder.embed(['زيت زيتون']);
        emb = { ok: r.vecs.length === 1 && r.vecs[0].length > 0, model: r.model };
      } catch (e) {
        emb = { ok: false, model: this.embedCfg?.model || null, error: (e as Error).message };
      }
    }
    if (!this.llm) return { ok: false, model: null, ms: 0, error: 'No chat model key on this site (GROQ_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY): rules and templates write the drafts.', embeddings: emb };
    const t0 = Date.now();
    try {
      const r = await this.llm.chatJSON<{ ok: boolean }>({ name: 'ping', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }, system: 'Reply with JSON.', user: 'Return {"ok": true}.', maxTokens: 400, timeoutMs: 20000 });
      return { ok: !!r.data.ok, model: r.model, ms: Date.now() - t0, embeddings: emb };
    } catch (e) {
      return { ok: false, model: this.llmCfg?.model || null, ms: Date.now() - t0, error: (e as Error).message, embeddings: emb };
    }
  }
}

// A random token stored with the data, so only this site can start its own background jobs.
// Created once with an atomic "only if new" write, so parallel first calls agree on the same token.
let tokenPromise: Promise<string> | null = null;
export function internalToken(app: App): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const k = 'meta/token';
      const existing = await app.stores.catalog.getJSON<{ token: string }>(k);
      if (existing?.token) return existing.token;
      const token = Array.from(crypto.getRandomValues(new Uint8Array(18)), (x) => x.toString(16).padStart(2, '0')).join('');
      await app.stores.catalog.setJSONIfNew(k, { token });
      const saved = await app.stores.catalog.getJSON<{ token: string }>(k);
      return saved?.token || token;
    })().catch((e) => {
      tokenPromise = null;
      throw e;
    });
  }
  return tokenPromise;
}
