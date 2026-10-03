// The post graph: runs once when a post is published. It finds the products in the post (image + caption)
// and links them to the catalog, so every comment under the post knows what "it" refers to.
//
//  read_post -> spot_products -> link_catalog -> save_context -> END
import type { LlmClient } from '../llm';
import { POST_SCHEMA, postPrompt } from '../prompts';
import type { Catalog } from '../query';
import { ACCEPT, decide, type SearchEngine } from '../search';
import type { PostCtx, PostProduct, PostRec } from '../types';
import { postProductsRules } from '../understand';
import { compileGraph, type GraphDef, type TraceItem } from './runtime';

export interface PostDeps {
  catalog: Catalog;
  engine: SearchEngine;
  llm: LlmClient | null;
  loadPost(postId: string): Promise<PostRec | null>;
  loadImageDataUrl(post: PostRec): Promise<string | null>;
}

export interface PostState {
  post_id: string;
  post: PostRec | null;
  image: string | null;
  spotted: { name: string; pack: string | null }[];
  summary: string;
  by: 'ai' | 'rules';
  linked: PostProduct[];
  ctx: PostCtx | null;
  notes: string[];
  trace: TraceItem[];
}

export function postGraphDef(d: PostDeps): GraphDef<PostState> {
  return {
    name: 'post',
    channels: { post_id: 'last', post: 'last', image: 'last', spotted: 'last', summary: 'last', by: 'last', linked: 'last', ctx: 'last', notes: 'append', trace: 'append' },
    start: 'read_post',
    nodes: {
      async read_post(s) {
        const post = await d.loadPost(s.post_id);
        if (!post) return { post: null, note: 'Post not found' };
        const image = d.llm?.vision ? await d.loadImageDataUrl(post) : null; // text-only models get the caption alone
        return { post, image, note: image ? 'Caption and image loaded' : d.llm && !d.llm.vision ? 'Caption loaded (this model reads text only)' : 'Caption loaded' };
      },

      async spot_products(s) {
        const post = s.post!;
        if (d.llm) {
          try {
            const hints = d.engine.allEntries('product').map((e) => `${e.name} (${e.name_ar})`);
            const p = postPrompt({ caption: post.caption, productHints: hints, withImage: !!s.image });
            const r = await d.llm.chatJSON<{ products: { name: string; pack: string | null }[]; summary: string }>({ name: 'analyze_post', schema: POST_SCHEMA as unknown as Record<string, unknown>, system: p.system, user: p.user, images: s.image ? [s.image] : [], maxTokens: 2500 });
            return { spotted: (r.data.products || []).slice(0, 6), summary: r.data.summary || '', by: 'ai', note: `${r.model} ${s.image ? 'saw' : 'read'}: ${(r.data.products || []).map((x) => x.name).join(', ') || 'nothing'}` };
          } catch (e) {
            const matches = await postProductsRules(post.caption, d.engine);
            return { spotted: matches.map((m) => ({ name: m.entry.name, pack: null })), summary: '', by: 'rules', notes: [`The AI model could not analyse the post (${(e as Error).message}); read the caption with rules.`], note: 'Rules (AI call failed)' };
          }
        }
        const matches = await postProductsRules(post.caption, d.engine);
        return { spotted: matches.map((m) => ({ name: m.entry.name, pack: null })), summary: '', by: 'rules', note: `Caption mentions: ${matches.map((m) => m.entry.name).join(', ') || 'no known product'}` };
      },

      async link_catalog(s) {
        const linked: PostProduct[] = [];
        const notes: string[] = [];
        for (const sp of s.spotted) {
          const res = await d.engine.search(sp.name, ['product'], 5);
          const dec = decide(res);
          const m = dec.status === 'match' ? dec.match : dec.status === 'ambiguous' ? dec.options[0] : null;
          if (!m || m.conf < ACCEPT) {
            notes.push(`"${sp.name}" is not in the catalog.`);
            continue;
          }
          if (linked.some((l) => l.id === m.entry.id)) continue;
          linked.push({ id: m.entry.id, name: m.entry.name, name_ar: m.entry.name_ar, pack: sp.pack, source: s.by, conf: Number(m.conf.toFixed(2)) });
        }
        return { linked, notes, note: linked.map((l) => `${l.name} (${l.conf})`).join(', ') || 'No catalog product found' };
      },

      async save_context(s) {
        const ctx: PostCtx = {
          post_id: s.post_id,
          status: 'done',
          products: s.linked,
          summary: s.summary,
          by: s.by,
          analyzed_at: new Date().toISOString(),
        };
        return { ctx, note: `${s.linked.length} product(s) linked to the post` };
      },
    },
    edges: [
      ['spot_products', 'link_catalog'],
      ['link_catalog', 'save_context'],
      ['save_context', 'END'],
    ],
    branches: [{ from: 'read_post', route: (s) => (s.post ? 'ok' : 'missing'), map: { ok: 'spot_products', missing: 'END' } }],
  };
}

export async function runPost(d: PostDeps, postId: string): Promise<PostCtx | null> {
  const graph = await compileGraph(postGraphDef(d));
  const out = await graph.invoke({ post_id: postId, spotted: [], linked: [], summary: '', image: null, ctx: null });
  if (!out.ctx) return null;
  return { ...out.ctx, engine: graph.engine, trace: out.trace || [], notes: out.notes || [] };
}
