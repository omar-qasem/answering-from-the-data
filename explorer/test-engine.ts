// Checks that the explorer's detailed search equals the backend's search, and that its graph runs equal the backend's runAsk.
process.env.GRAPH_ENGINE = 'built-in';
import * as X from './entry';
import { runAsk as backendRunAsk } from '../team-console/src/graphs/ask';
import type { EntryType } from '../team-console/src/ingest';
import { tokenVariants } from '../team-console/src/text';

async function main() {
const { engine, catalog, seed } = X._internals;
const PROD: EntryType[] = ['product', 'category'];
const PLACE: EntryType[] = ['area', 'city', 'region', 'store'];
const STORE: EntryType[] = ['store'];
const mentions: [string, EntryType[]][] = [];
for (const m of ['زيت زيتوون', 'زيت', 'رز', 'زيت زيتون', 'olive oil', 'حليب بودره', 'قهوه', 'شاي اخضر', 'شاي أخضر', 'طحينه', 'الطحينة', 'حلاوه', 'فريكه', 'tuna', 'tahini', 'basmati', 'سكر', 'معكرونه', 'حمص', 'عدس', 'xyz', 'زيت ذرة', 'coffee', 'green tea', 'milk powder', 'الحجم الوسط']) mentions.push([m, PROD]);
for (const m of ['بالزرقا', 'خلدا', 'بخلدا', 'عبدون', 'Aqaba', 'اربد', 'بإربد', 'مادبا', 'الشميساني', 'الجبيهه', 'بالجبيهة', 'ماركا', 'بماركا', 'كارفور الجاليريا', 'السلط', 'Abdoun', 'عمان', 'بعمان', 'Irbid', 'الوسط', 'zarqa', 'sweifieh']) mentions.push([m, PLACE]);
for (const m of ['كارفور الجاليريا', 'سيفوي', 'Carrefour Galleria', 'سامح مول']) mentions.push([m, STORE]);

let bad = 0;
for (const [m, types] of mentions) {
  const mine = X.searchDetail(m, types, 6);
  const real = await engine.search(m, types, 6, null);
  const a = mine.matches.map((x) => `${x.entry.id}|${x.conf}|${x.score}|${x.alias}`).join(' ; ');
  const b = real.map((x) => `${x.entry.id}|${x.conf}|${x.score}|${x.alias}`).join(' ; ');
  if (a !== b) { bad++; console.log('MISMATCH', m, '\n  mine', a, '\n  real', b); }
  // the BM25 parts must add up to the engine's own BM25
  const E = engine as any;
  const qv = new Set<string>(); for (const t of mine.base) for (const v of tokenVariants(t)) qv.add(v);
  for (const c of mine.cands) {
    const ref = E.bm25([...qv], c.i);
    if (Math.abs(ref - c.bm) > 1e-12) { bad++; console.log('BM25 MISMATCH', m, c.alias, ref, c.bm); }
  }
  const dec = mine.decision;
  const top = mine.best[0];
  console.log(`${m.padEnd(20)} ${dec.status.padEnd(9)} ${top ? `${top.alias} (${top.type}) conf ${top.conf.toFixed(2)} bm#${top.rBm} ch#${top.rFz}` : '-'}  cands=${mine.cands.length}`);
}
console.log(bad ? `\n${bad} PROBLEMS` : '\nsearchDetail == engine.search for all mentions');

// char vector pieces rebuild the same vector
const cp = X.charPieces('زيت زيتون');
const v = new Float64Array(512);
for (const w of cp.words) for (const p of w.pieces) v[p.slot] += p.w;
const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const diff = cp.vec.reduce((s, x, i) => Math.max(s, Math.abs(x - v[i] / n)), 0);
console.log('char pieces rebuild vector, max diff', diff.toExponential(2), 'nonzero', cp.nonzero);

// graph runs: the explorer wrapper vs the backend's runAsk with the same inputs
let gbad = 0;
for (const c of seed.comments) {
  const mine = await X.runAsk({ postId: c.post_id, text: c.text, personaId: c.persona_id });
  const post = seed.posts.find((p) => p.id === c.post_id)!;
  const ctx = seed.ctxs.find((x) => x.post_id === c.post_id)!;
  const real = await backendRunAsk({ catalog, engine, llm: null, loadComment: async () => ({ ...c }), loadPost: async () => post, ensurePostContext: async () => ctx, today: new Date().toISOString().slice(0, 10) }, { post_id: c.post_id, comment_id: c.id });
  const same = mine.draft!.text === real.draft!.text && mine.draft!.status === real.draft!.status && JSON.stringify(mine.draft!.trace.map((t) => [t.node, t.note])) === JSON.stringify(real.draft!.trace.map((t) => [t.node, t.note]));
  if (!same) { gbad++; console.log('GRAPH MISMATCH', c.text, '\n', mine.draft!.text, '\n', real.draft!.text); }
  console.log(`${c.text.slice(0, 34).padEnd(36)} ${mine.draft!.status.padEnd(12)} ${mine.draft!.trace.map((t) => t.node).join(' > ')}  [${mine.calls.length} searches, engine ${mine.engine}]`);
}
console.log(gbad ? `${gbad} GRAPH PROBLEMS` : 'runAsk (explorer) == runAsk (backend) for all seeded comments');

const p = await X.runPost(seed.posts.find((x) => x.id === 'post-tahini-halawa')!.caption);
console.log('post graph:', p.ctx?.products.map((x) => `${x.name} ${x.conf}`).join(', '), '|', p.updates.map((u) => u.node).join(' > '));
const shapes = X.graphShapes();
console.log('ask nodes', shapes.ask.nodes.length, 'edges', shapes.ask.edges.length, 'branches', shapes.ask.branches.map((b) => Object.keys(b.map).length).join('+'), 'channels', Object.keys(shapes.ask.channels).length);
const di = X.dataInfo();
console.log('data:', di.rawRows, 'raw rows, kept', di.kept, 'repeated keys', di.repeatedKeys, 'entries', JSON.stringify(di.byType), 'docs', di.sizes.docs, JSON.stringify(di.docsByType));
console.log('sample raw', JSON.stringify(di.sampleRaw.map((x) => x.value)));
console.log('sample clean', JSON.stringify(di.sampleClean));
console.log('bm25', JSON.stringify(di.bm25));

}
main().catch((e) => { console.error(e); process.exit(1); });
