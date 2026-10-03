// The ask graph: one run per customer comment. It prepares a draft; nothing is sent until the team clicks "Reply now".
//
//  load_context -> understand_comment -+-> find_entities -+-> check_shelves -> write_answer -> fact_check -+
//                                      |                  +-> ask_clarify ------------------------------+
//                                      +-> write_courtesy ---------------------------------------------+-> assemble_draft -> END
//                                      +-> hand_off ---------------------------------------------------+
//                                      +-> no_reply ---------------------------------------------------+
import type { Entry } from '../ingest';
import type { LlmClient } from '../llm';
import { COMPOSE_SCHEMA, UNDERSTAND_SCHEMA, composePrompt, understandPrompt } from '../prompts';
import type { Catalog, Place, ProductAnswer } from '../query';
import { basisOf, checkReply, enName, factsFor, firstName, templateAnswer, templateClarify, templateCourtesy, templateHandoff, type Lang, type ReplyKind } from '../reply';
import { decide, type SearchEngine } from '../search';
import { hasArabic } from '../text';
import type { CommentRec, DraftOption, DraftRec, PostCtx, PostRec } from '../types';
import { understandRules, type Understanding } from '../understand';
import { compileGraph, type CompiledGraph, type GraphDef, type TraceItem } from './runtime';

export interface AskDeps {
  catalog: Catalog;
  engine: SearchEngine;
  llm: LlmClient | null;
  loadComment(postId: string, commentId: string): Promise<CommentRec | null>;
  loadPost(postId: string): Promise<PostRec | null>;
  ensurePostContext(postId: string): Promise<PostCtx | null>;
  today: string;
}

export interface Choice {
  slot: 'product' | 'place';
  id: string;
}

export interface AskState {
  post_id: string;
  comment_id: string;
  choice: Choice | null;
  comment: CommentRec | null;
  post: PostRec | null;
  post_ctx: PostCtx | null;
  understanding: Understanding | null;
  products: Entry[];
  place: Place | null;
  clarify: { slot: 'product' | 'place'; options: DraftOption[]; ask_place: boolean } | null;
  pack_text: string | null;
  answers: ProductAnswer[];
  reply: string;
  kind: ReplyKind;
  written_by: 'ai' | 'template' | null;
  checks: string[];
  model: string | null;
  draft: DraftRec | null;
  notes: string[];
  trace: TraceItem[];
}

const CHANNELS: GraphDef<AskState>['channels'] = {
  post_id: 'last',
  comment_id: 'last',
  choice: 'last',
  comment: 'last',
  post: 'last',
  post_ctx: 'last',
  understanding: 'last',
  products: 'last',
  place: 'last',
  clarify: 'last',
  pack_text: 'last',
  answers: 'last',
  reply: 'last',
  kind: 'last',
  written_by: 'last',
  checks: 'last',
  model: 'last',
  draft: 'last',
  notes: 'append',
  trace: 'append',
};

const PLACE_RANK: Record<string, number> = { store: 0, area: 1, city: 2, region: 3 };

function option(e: Entry): DraftOption {
  return { id: e.id, label: e.type === 'product' ? e.name : e.name, label_ar: e.name_ar };
}

export function askGraphDef(d: AskDeps): GraphDef<AskState> {
  const nameOf = (s: AskState) => firstName(s.comment?.author_name || '');
  const langOf = (s: AskState): Lang => s.understanding?.lang || (hasArabic(s.comment?.text || '') ? 'ar' : 'en');

  return {
    name: 'ask',
    channels: CHANNELS,
    start: 'load_context',
    nodes: {
      // 1. the comment, its post, and the products the post was linked to when it was published
      async load_context(s) {
        const comment = await d.loadComment(s.post_id, s.comment_id);
        if (!comment) return { comment: null, note: 'Comment not found' };
        const post = await d.loadPost(s.post_id);
        const ctx = await d.ensurePostContext(s.post_id);
        return { comment, post, post_ctx: ctx, note: `Post products: ${(ctx?.products || []).map((p) => p.name).join(', ') || 'none'}` };
      },

      // 2. what does the customer want? (the AI model with a strict schema; rules when there is no key or the call fails)
      async understand_comment(s) {
        const c = s.comment!;
        let u: Understanding | null = null;
        let model: string | null = null;
        const notes: string[] = [];
        if (d.llm) {
          try {
            const products = d.engine.allEntries('product').map((e) => `${e.name} (${e.name_ar})`);
            const places = [...d.engine.allEntries('city'), ...d.engine.allEntries('area')].map((e) => `${e.name} (${e.name_ar})`);
            const p = understandPrompt({ caption: s.post?.caption || '', postProducts: (s.post_ctx?.products || []).map((x) => `${x.name} (${x.name_ar})`), name: c.author_name, comment: c.text, productHints: products, placeHints: places });
            const r = await d.llm.chatJSON<Omit<Understanding, 'by' | 'lang'> & { language: Lang }>({ name: 'understand_comment', schema: UNDERSTAND_SCHEMA as unknown as Record<string, unknown>, system: p.system, user: p.user, maxTokens: 2500 });
            const x = r.data;
            u = {
              intent: x.intent,
              lang: hasArabic(c.text) ? (x.language === 'en' && !/[؀-ۿ]{3,}/.test(c.text) ? 'en' : 'ar') : 'en',
              wants_price: !!x.wants_price || x.intent === 'price',
              products: (x.products || []).filter(Boolean).slice(0, 4),
              uses_post_product: !!x.uses_post_product,
              pack: x.pack || null,
              locations: (x.locations || []).filter(Boolean).slice(0, 4),
              stores: (x.stores || []).filter(Boolean).slice(0, 3),
              short_reply: x.short_reply || null,
              reason: x.reason || '',
              by: 'ai',
            };
            model = r.model;
          } catch (e) {
            notes.push(`The AI model could not read the comment (${(e as Error).message}); used the rules instead.`);
          }
        }
        if (!u) u = await understandRules(c.text, d.engine);
        const summary = `${u.intent}${u.wants_price ? ' + price' : ''} · products: ${u.products.join(', ') || '-'} · places: ${[...u.stores, ...u.locations].join(', ') || '-'} (${u.by})`;
        return { understanding: u, model, notes, note: summary };
      },

      // 3. hybrid search: which product(s) and which place do the words point to?
      async find_entities(s) {
        const u = s.understanding!;
        const notes: string[] = [];
        const postIds = new Set((s.post_ctx?.products || []).map((p) => p.id));
        const postEntries = [...postIds].map((id) => d.catalog.entries.get(id)).filter((e): e is Entry => !!e);
        const products: Entry[] = [];
        let clarify: AskState['clarify'] = null;
        const addProduct = (e: Entry) => {
          if (!products.some((p) => p.id === e.id)) products.push(e);
        };

        if (s.choice?.slot === 'product') {
          const e = d.catalog.entries.get(s.choice.id);
          if (e) {
            addProduct(e);
            notes.push(`The team picked ${e.name}.`);
          }
        } else {
          const qVecs = await d.engine.embedMany(u.products);
          for (let i = 0; i < u.products.length; i++) {
            const m = u.products[i];
            const res = await d.engine.search(m, ['product', 'category'], 6, qVecs[i]);
            const dec = decide(res);
            if (dec.status === 'match') {
              const e = dec.match.entry;
              if (e.type === 'product') addProduct(e);
              else {
                // a category ("زيت"): use the post's products from that category, otherwise ask
                const inCat = postEntries.filter((p) => (p.meta as Record<string, unknown>).category === e.name);
                if (inCat.length) inCat.forEach(addProduct);
                else {
                  const opts = d.catalog.rows.filter((r) => r.category === e.name).map((r) => r.product_key);
                  const uniq = [...new Set(opts)].map((k) => d.catalog.entry('product', k)).filter((x): x is Entry => !!x);
                  clarify = { slot: 'product', options: uniq.slice(0, 4).map(option), ask_place: false };
                }
              }
              notes.push(`"${m}" → ${e.name} (${dec.match.conf.toFixed(2)})`);
            } else if (dec.status === 'ambiguous') {
              const opts = dec.options.map((o) => o.entry).filter((e) => e.type === 'product');
              const fromPost = opts.filter((e) => postIds.has(e.id));
              if (fromPost.length === 1) {
                addProduct(fromPost[0]);
                notes.push(`"${m}" could be ${opts.map((o) => o.name).join(' / ')}; the post shows ${fromPost[0].name}, so that one.`);
              } else {
                clarify = { slot: 'product', options: (fromPost.length ? fromPost : opts).slice(0, 4).map(option), ask_place: false };
                notes.push(`"${m}" is unclear: ${opts.map((o) => o.name).join(' / ')}.`);
              }
            } else notes.push(`"${m}" did not match any product.`);
          }
          if (!products.length && !clarify) {
            if (postEntries.length) {
              postEntries.slice(0, 3).forEach(addProduct);
              notes.push(`No product named; using the post's product${postEntries.length > 1 ? 's' : ''}.`);
            } else clarify = { slot: 'product', options: [], ask_place: false };
          }
        }

        // places: a named shop beats an area, an area beats a city
        let place: Place | null = null;
        if (s.choice?.slot === 'place') {
          const e = d.catalog.entries.get(s.choice.id);
          if (e) {
            place = d.catalog.place(e);
            notes.push(`The team picked ${e.name}.`);
          }
        } else {
          const cands: { e: Entry; conf: number }[] = [];
          const mentions = [...u.stores.map((m) => ({ m, types: ['store'] as const })), ...u.locations.map((m) => ({ m, types: ['area', 'city', 'region', 'store'] as const }))];
          for (const { m, types } of mentions) {
            const res = await d.engine.search(m, [...types], 6);
            const dec = decide(res);
            if (dec.status === 'match') {
              cands.push({ e: dec.match.entry, conf: dec.match.conf });
              notes.push(`"${m}" → ${dec.match.entry.name} (${dec.match.entry.type}, ${dec.match.conf.toFixed(2)})`);
            } else if (dec.status === 'ambiguous' && !clarify) {
              clarify = { slot: 'place', options: dec.options.slice(0, 4).map((o) => option(o.entry)), ask_place: false };
              notes.push(`"${m}" is unclear: ${dec.options.map((o) => o.entry.name).join(' / ')}.`);
            } else if (dec.status === 'none') notes.push(`"${m}" did not match a place we have.`);
          }
          cands.sort((a, b) => PLACE_RANK[a.e.type] - PLACE_RANK[b.e.type] || b.conf - a.conf);
          if (cands[0]) place = d.catalog.place(cands[0].e);
        }
        if (clarify && clarify.slot === 'product') clarify.ask_place = !place && u.intent !== 'price';
        return { products: products.slice(0, 3), place, clarify, pack_text: u.pack || s.comment!.text, notes, note: `${products.map((p) => p.name).join(' + ') || 'no product'} @ ${place ? `${place.name} (${place.type})` : 'no place'}${clarify ? ' · needs a choice' : ''}` };
      },

      // 4. the exact part: filter the availability table (no model involved)
      async check_shelves(s) {
        const answers = s.products.map((p) => d.catalog.productAnswer(p.id, { place: s.place, packText: s.pack_text || '' }));
        const note = answers.map((a) => `${a.product.name}: ${a.available.length} shop(s) with it in ${a.used ? a.used.name : 'the country'}${a.widened ? ` (nothing on the shelf in ${a.requested?.name})` : ''}`).join(' · ');
        return { answers, note };
      },

      // 5. write the reply from the facts only (AI model), or fill the template
      async write_answer(s) {
        const u = s.understanding!;
        const lang = langOf(s);
        const name = nameOf(s);
        const priceOnly = u.intent === 'price';
        const template = templateAnswer(s.answers, { lang, name, wantsPrice: u.wants_price, priceOnly });
        if (!d.llm) return { reply: template, written_by: 'template', note: 'Template (no AI key)' };
        try {
          const facts = factsFor(s.answers, { lang, name, wantsPrice: u.wants_price, priceOnly, today: d.today });
          const p = composePrompt({ comment: s.comment!.text, facts, lang });
          const r = await d.llm.chatJSON<{ reply: string }>({ name: 'compose_reply', schema: COMPOSE_SCHEMA as unknown as Record<string, unknown>, system: p.system, user: p.user, maxTokens: 2500 });
          const text = String(r.data.reply || '').trim();
          if (!text) throw new Error('empty reply');
          return { reply: text, written_by: 'ai', model: r.model, note: `Written by ${r.model} in ${r.ms} ms` };
        } catch (e) {
          return { reply: template, written_by: 'template', notes: [`The AI model could not write the reply (${(e as Error).message}); used the template.`], note: 'Template (AI call failed)' };
        }
      },

      // 6. every shop, date and price in an AI reply must come from the data; otherwise use the template
      async fact_check(s) {
        const u = s.understanding!;
        const priceOnly = u.intent === 'price';
        const problems = checkReply(s.reply, s.answers, d.catalog, { wantsPrice: u.wants_price, priceOnly });
        if (!problems.length) return { checks: [], note: 'Passed: shops, dates and prices match the data' };
        if (s.written_by === 'ai') {
          const template = templateAnswer(s.answers, { lang: langOf(s), name: nameOf(s), wantsPrice: u.wants_price, priceOnly });
          return { reply: template, written_by: 'template', checks: problems, notes: [`The AI reply failed the fact check (${problems.join(' ')}) so the template was used.`], note: `Failed (${problems.length}) → template` };
        }
        return { checks: problems, note: `Template check: ${problems.join(' ')}` };
      },

      async ask_clarify(s) {
        const c = s.clarify!;
        const lang = langOf(s);
        const labels = c.options.map((o) => (lang === 'ar' ? o.label_ar : c.slot === 'product' ? enName({ key: o.id.split(':')[1], name: o.label }) : o.label));
        return { reply: templateClarify({ lang, name: nameOf(s), options: labels, askPlace: c.ask_place, slot: c.slot }), written_by: 'template', kind: 'clarify', note: `Asks which ${c.slot}: ${c.options.map((o) => o.label).join(' / ') || 'open question'}` };
      },

      async write_courtesy(s) {
        const u = s.understanding!;
        const safe = u.short_reply && !/\d/.test(u.short_reply) && u.short_reply.length <= 220;
        return { reply: safe ? u.short_reply! : templateCourtesy(langOf(s), nameOf(s)), written_by: safe ? 'ai' : 'template', kind: 'courtesy', note: 'A short thank-you (optional to send)' };
      },

      async hand_off(s) {
        const u = s.understanding!;
        const safe = u.short_reply && !/\d/.test(u.short_reply) && u.short_reply.length <= 260;
        const why = u.intent === 'complaint' ? 'complaint' : 'question';
        return { reply: safe ? u.short_reply! : templateHandoff(langOf(s), nameOf(s), why), written_by: safe ? 'ai' : 'template', kind: 'handoff', note: why === 'complaint' ? 'Complaint: a person should follow up' : 'Not an availability question: a person should answer' };
      },

      async no_reply() {
        return { reply: '', written_by: null, kind: 'none', note: 'Nothing to answer' };
      },

      // 7. one draft record for the team page: the text, what it relied on, and how it was made
      async assemble_draft(s) {
        const u = s.understanding;
        const kind: ReplyKind = s.kind || (s.answers.length ? 'answer' : 'none');
        const status = kind === 'answer' || kind === 'courtesy' ? 'ready' : kind === 'clarify' ? 'needs_choice' : kind === 'handoff' ? 'needs_human' : 'no_reply';
        const a0 = s.answers[0];
        const scope = s.answers.length
          ? s.answers
              .map((a) =>
                a.widened
                  ? `${a.product.name}: ${a.steps[0].stores ? 'not on the shelf' : 'no shop carries it'} in ${a.requested?.name} at the last visit → shops in ${a.used ? a.used.name : 'other cities'}`
                  : a.requested
                    ? `${a.product.name}: ${a.available.length} shop(s) in ${a.requested.name}`
                    : `${a.product.name}: no place given → ${a.available.length} shops nationwide`,
              )
              .join(' · ')
          : null;
        const draft: DraftRec = {
          comment_id: s.comment_id,
          post_id: s.post_id,
          status,
          kind,
          text: s.reply || '',
          lang: langOf(s),
          intent: u?.intent ?? null,
          understood_by: u?.by ?? null,
          written_by: s.written_by,
          engine: null,
          model: s.model,
          products: s.products.map((p) => ({ id: p.id, name: p.name, name_ar: p.name_ar })),
          place: s.place ? { type: s.place.type, key: s.place.key, name: s.place.name, name_ar: s.place.name_ar } : null,
          scope_note: scope,
          pack: a0?.pack?.pack ?? null,
          basis: basisOf(s.answers),
          options: s.clarify && s.clarify.options.length ? { slot: s.clarify.slot, items: s.clarify.options } : null,
          checks: s.checks || [],
          notes: s.notes || [],
          trace: [],
          reason: u?.reason || '',
          created_at: new Date().toISOString(),
          ms: 0,
          choice: s.choice,
        };
        return { draft, kind, note: `Draft: ${status}` };
      },
    },
    edges: [
      ['check_shelves', 'write_answer'],
      ['write_answer', 'fact_check'],
      ['fact_check', 'assemble_draft'],
      ['ask_clarify', 'assemble_draft'],
      ['write_courtesy', 'assemble_draft'],
      ['hand_off', 'assemble_draft'],
      ['no_reply', 'assemble_draft'],
      ['assemble_draft', 'END'],
    ],
    branches: [
      { from: 'load_context', route: (s) => (s.comment ? 'found' : 'missing'), map: { found: 'understand_comment', missing: 'END' } },
      {
        from: 'understand_comment',
        route: (s) => {
          const i = s.understanding!.intent;
          if (i === 'availability' || i === 'price') return 'find';
          if (i === 'praise') return 'thanks';
          if (i === 'complaint' || i === 'other_question') return 'person';
          return 'skip';
        },
        map: { find: 'find_entities', thanks: 'write_courtesy', person: 'hand_off', skip: 'no_reply' },
      },
      { from: 'find_entities', route: (s) => (s.clarify ? 'clarify' : 'answer'), map: { clarify: 'ask_clarify', answer: 'check_shelves' } },
    ],
  };
}

export async function runAsk(d: AskDeps, input: { post_id: string; comment_id: string; choice?: Choice | null }): Promise<{ draft: DraftRec | null; engine: CompiledGraph<AskState>['engine'] }> {
  const t0 = Date.now();
  const graph = await compileGraph(askGraphDef(d));
  const out = await graph.invoke({ post_id: input.post_id, comment_id: input.comment_id, choice: input.choice ?? null, products: [], answers: [], checks: [], clarify: null, place: null, reply: '', model: null, written_by: null, draft: null });
  if (!out.draft) return { draft: null, engine: graph.engine };
  const draft = { ...out.draft, engine: graph.engine, trace: out.trace || [], notes: out.notes || [], ms: Date.now() - t0 };
  return { draft, engine: graph.engine };
}
