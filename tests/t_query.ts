import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildDataset } from '../team-console/src/ingest';
import { Catalog, resolvePack, packAmount } from '../team-console/src/query';
const csv = readFileSync(new URL('../team-console/public/sample/pos_availability.csv', import.meta.url), 'utf8');
const ds = buildDataset(csv);
const cat = new Catalog(ds);
const P = (id: string) => { const e = cat.entries.get(id)!; assert.ok(e, id); return cat.place(e); };
function show(label: string, a: ReturnType<Catalog['productAnswer']>) {
  console.log(`\n== ${label}: ${a.product.name} | pack=${a.pack?.pack ?? '-'} asked=${a.pack_asked} missing=${a.pack_missing} | req=${a.requested?.name ?? 'none'} used=${a.used?.name ?? 'COUNTRY'} widened=${a.widened}`);
  console.log('   steps:', a.steps.map(s => `${s.place?.name ?? 'country'}:${s.available}/${s.stores}`).join(' -> '));
  console.log('   avail:', a.available.slice(0, 4).map(l => `${l.store_name} [${l.area}, ${l.city}] ${l.best} ${l.items.map(i => i.pack + ':' + i.status + ':' + i.qty + ':' + i.price).join('/')} @${l.date}`).join(' || '));
  console.log('   out in requested:', a.out_in_requested.map(l => `${l.store_name}@${l.date}`).join(', ') || '-', '| price', a.price, '| dates', a.dates, '| byCity', a.by_city.slice(0, 4).map(c => `${c.city}:${c.stores}`).join(','));
}
show('olive oil @ Khalda', cat.productAnswer('product:olive oil extra virgin', { place: P('area:khalda') }));
show('olive oil @ Zarqa', cat.productAnswer('product:olive oil extra virgin', { place: P('city:zarqa') }));
show('olive oil @ Aqaba', cat.productAnswer('product:olive oil extra virgin', { place: P('city:aqaba') }));
show('freekeh @ Al Salt', cat.productAnswer('product:freekeh', { place: P('area:al salt center') }));
show('freekeh @ Amman', cat.productAnswer('product:freekeh', { place: P('city:amman') }));
show('halawa @ Madaba', cat.productAnswer('product:halawa plain', { place: P('city:madaba') }));
show('tahini @ Madaba', cat.productAnswer('product:tahini', { place: P('city:madaba') }));
show('green tea @ Jubaiha', cat.productAnswer('product:green tea bags', { place: P('area:al jubaiha') }));
show('coffee @ Abdoun', cat.productAnswer('product:turkish coffee ground', { place: P('area:abdoun') }));
show('coffee @ Sameh Mall Abdoun', cat.productAnswer('product:turkish coffee ground', { place: P('store:st-002') }));
show('milk big @ Irbid', cat.productAnswer('product:full cream milk powder', { place: P('city:irbid'), packText: 'في منه الكبير ٢ كيلو بإربد؟' }));
show('milk no place', cat.productAnswer('product:full cream milk powder', {}));
show('rice basmati @ Marka', cat.productAnswer('product:basmati rice', { place: P('area:marka') }));
show('olive oil 2 kilo', cat.productAnswer('product:olive oil extra virgin', { packText: 'بدي عبوة 2 كيلو' }));
const packs = cat.packsOf('full cream milk powder');
console.log('\npacks', packs);
const cases: [string, string | null][] = [['الكبير', 'SKU-2022'], ['٢ كيلو', 'SKU-2022'], ['1.8kg', 'SKU-2022'], ['900 غرام', 'SKU-2021'], ['نص كيلو', 'SKU-2020'], ['الصغير', 'SKU-2020'], ['الوسط', 'SKU-2021'], ['وين بلاقيه', null], ['400g', 'SKU-2020']];
for (const [t, exp] of cases) { const r = resolvePack(t, packs); console.log('pack', t.padEnd(12), '->', r.pack?.sku ?? null, r.asked, r.missing); assert.equal(r.pack?.sku ?? null, exp, t); }
assert.deepEqual(packAmount('1.5 L'), { amount: 1500, unit: 'ml' }); assert.deepEqual(packAmount('100 bags'), { amount: 100, unit: 'unit' });
console.log('\nquery OK');
