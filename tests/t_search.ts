import { readFileSync } from 'node:fs';
import { buildDataset } from '../team-console/src/ingest';
import { SearchEngine, buildAliasDocs, decide } from '../team-console/src/search';
const csv = readFileSync(new URL('../team-console/public/sample/pos_availability.csv', import.meta.url), 'utf8');
const ds = buildDataset(csv);
const se = new SearchEngine(ds.entries, { version: 1, docs: buildAliasDocs(ds.entries), built_at: '' }, null);
const LOC = ['store', 'area', 'city', 'region'] as const;
const PROD = ['product', 'category'] as const;
const cases: [string, readonly any[], string][] = [
  ['خلدا', LOC, 'area:khalda'], ['بخلدا', LOC, 'area:khalda'], ['الزرقا', LOC, 'city:zarqa'], ['بالزرقاء', LOC, 'city:zarqa'], ['زرقا', LOC, 'city:zarqa'],
  ['اربد', LOC, 'city:irbid'], ['إربد', LOC, 'city:irbid'], ['Irbid', LOC, 'city:irbid'], ['بالعقبة', LOC, 'city:aqaba'], ['عمان', LOC, 'city:amman'], ['عمّان', LOC, 'city:amman'],
  ['الصويفيه', LOC, 'area:swaifieh'], ['صويفية', LOC, 'area:swaifieh'], ['Sweifiyeh', LOC, 'area:swaifieh'], ['السلط', LOC, 'area:al salt center'], ['مادبا', LOC, 'city:madaba'], ['الكرك', LOC, 'city:karak'],
  ['كارفور الجاليريا', LOC, 'store:st-004'], ['سيتي مول', LOC, 'store:st-003'], ['Carrefour Galleria', LOC, 'store:st-004'], ['سامح مول عبدون', LOC, 'store:st-002'], ['الجبيهة', LOC, 'area:al jubaiha'], ['ام اذينة', LOC, 'area:um uthaina'], ['البترا', LOC, 'area:wadi musa'], ['الشمال', LOC, 'region:north'],
  ['زيت زيتون', PROD, 'product:olive oil extra virgin'], ['زيت الزيتون', PROD, 'product:olive oil extra virgin'], ['olive oil', PROD, 'product:olive oil extra virgin'], ['فريكه', PROD, 'product:freekeh'], ['الفريكة', PROD, 'product:freekeh'], ['طحينة', PROD, 'product:tahini'], ['الحلاوة', PROD, 'product:halawa plain'], ['حلاوه', PROD, 'product:halawa plain'],
  ['قهوة تركية', PROD, 'product:turkish coffee ground'], ['القهوه', PROD, 'product:turkish coffee ground'], ['حليب بودرة', PROD, 'product:full cream milk powder'], ['رب البندورة', PROD, 'product:tomato paste'], ['تونة', PROD, 'product:tuna chunks in oil'], ['عدس', PROD, 'product:red lentils'], ['سكر', PROD, 'product:white sugar'], ['شعيرية', PROD, 'product:vermicelli pasta'], ['نسكافيه', PROD, 'product:instant coffee'],
];
let ok = 0;
for (const [m, types, exp] of cases) {
  const r = await se.search(m, [...types]);
  const d = decide(r);
  const got = d.status === 'match' ? d.match.entry.id : d.status;
  const pass = got === exp;
  if (pass) ok++;
  console.log(pass ? 'ok  ' : 'FAIL', m.padEnd(20), '->', got.padEnd(34), r.slice(0, 3).map((x) => `${x.entry.id}:${x.conf.toFixed(2)}`).join(' | '));
}
console.log(`\n${ok}/${cases.length} resolved as expected`);
if (ok !== cases.length) process.exitCode = 1;
for (const m of ['زيت', 'شاي', 'رز', 'حليب', 'قهوة', 'مول', 'منيح', 'يعطيكم العافية', 'الحجم الكبير']) {
  const types = m === 'مول' ? [...LOC] : [...PROD];
  const r = await se.search(m, types);
  const d = decide(r);
  console.log('ambig/none check', m.padEnd(16), '->', d.status, d.status === 'ambiguous' ? d.options.map((o) => o.entry.id).join(', ') : d.status === 'match' ? d.match.entry.id : '');
}
