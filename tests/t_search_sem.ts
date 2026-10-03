// The same checks with mock "semantic" vectors switched on, to make sure vectors never break a word-level tie.
import { readFileSync } from 'node:fs';
import { buildDataset } from '../team-console/src/ingest';
import { SearchEngine, buildAliasDocs, decide, vecToB64 } from '../team-console/src/search';
import { fnv1a, tokens } from '../team-console/src/text';
const csv = readFileSync(new URL('../team-console/public/sample/pos_availability.csv', import.meta.url), 'utf8');
const ds = buildDataset(csv);
const docs = buildAliasDocs(ds.entries);
const vec = (t: string) => { const v = new Float32Array(256); for (const tok of tokens(t)) { const x = `#${tok}#`; for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= x.length; i++) v[fnv1a(x.slice(i, i + n)) % 256] += 1; } let s = 0; for (const a of v) s += a * a; s = Math.sqrt(s) || 1; return v.map((a) => a / s); };
const se = new SearchEngine(ds.entries, { version: 1, docs, built_at: '', semantic: { model: 'm', dims: 256, vecs: docs.map((d) => vecToB64(vec(d.text))) } }, async (texts) => texts.map(vec));
const expect: [string, string[], string][] = [['رز', ['product', 'category'], 'ambiguous'], ['شاي', ['product', 'category'], 'ambiguous'], ['حليب بودرة', ['product', 'category'], 'product:full cream milk powder'], ['قهوة', ['product', 'category'], 'product:turkish coffee ground'], ['زيت زيتون', ['product', 'category'], 'product:olive oil extra virgin'], ['سامح مول', ['store'], 'ambiguous'], ['الزرقاء', ['area', 'city', 'region', 'store'], 'city:zarqa'], ['خلدا', ['area', 'city', 'region', 'store'], 'area:khalda'], ['Irbid', ['area', 'city', 'region', 'store'], 'city:irbid'], ['tea', ['product', 'category'], 'ambiguous'], ['rice', ['product', 'category'], 'ambiguous'], ['زيت', ['product', 'category'], 'category:cooking oil'], ['حليب', ['product', 'category'], 'category:dairy']];
let ok = 0;
for (const [m, types, exp] of expect) {
  const d = decide(await se.search(m, types as any));
  const got = d.status === 'match' ? d.match.entry.id : d.status;
  console.log(got === exp ? 'ok  ' : 'FAIL', m, '->', got, d.status === 'ambiguous' ? d.options.map((o) => o.entry.id).join(', ') : '');
  if (got === exp) ok++;
}
console.log(`${ok}/${expect.length} with vectors on`);
if (ok !== expect.length) process.exitCode = 1;
