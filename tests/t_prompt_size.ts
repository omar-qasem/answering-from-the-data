// Rough token budget of each AI call (o200k-style estimate: ~3.8 ASCII chars/token, ~2.2 Arabic chars/token).
import { readFileSync } from 'node:fs';
import { buildDataset } from '../team-console/src/ingest';
import { Catalog } from '../team-console/src/query';
import { composePrompt, postPrompt, understandPrompt, UNDERSTAND_SCHEMA, COMPOSE_SCHEMA, POST_SCHEMA } from '../team-console/src/prompts';
import { factsFor } from '../team-console/src/reply';
const csv = readFileSync(new URL('../team-console/public/sample/pos_availability.csv', import.meta.url), 'utf8');
const ds = buildDataset(csv);
const cat = new Catalog(ds);
const est = (s: string) => { let a = 0, o = 0; for (const ch of s) (/[؀-ۿ]/.test(ch) ? a++ : o++); return Math.round(o / 3.8 + a / 2.2); };
const all = [...cat.entries.values()];
const products = all.filter((e) => e.type === 'product').map((e) => `${e.name} (${e.name_ar})`);
const cities = all.filter((e) => e.type === 'city').map((e) => `${e.name} (${e.name_ar})`);
const areas = all.filter((e) => e.type === 'area').map((e) => `${e.name} (${e.name_ar})`);
console.log('products', products.length, 'cities', cities.length, 'areas', areas.length, 'stores', all.filter((e) => e.type === 'store').length);
const u = understandPrompt({ caption: 'زيت زيتون بكر ممتاز من أرض الأردن 🫒 متوفر الآن بعبوات ١ لتر و ٢ لتر', postProducts: ['Olive Oil Extra Virgin (زيت زيتون بكر ممتاز)'], name: 'سارة أحمد', comment: 'وين بلاقيه بخلدا؟ وقديش سعره؟', productHints: products, placeHints: [...cities, ...areas] });
const uCities = understandPrompt({ caption: 'زيت زيتون بكر ممتاز من أرض الأردن 🫒 متوفر الآن بعبوات ١ لتر و ٢ لتر', postProducts: ['Olive Oil Extra Virgin (زيت زيتون بكر ممتاز)'], name: 'سارة أحمد', comment: 'وين بلاقيه بخلدا؟ وقديش سعره؟', productHints: products, placeHints: cities });
const schemaU = JSON.stringify(UNDERSTAND_SCHEMA);
console.log('understand: system', est(u.system), 'user', est(u.user), 'schema', est(schemaU), '=> total ≈', est(u.system) + est(u.user) + est(schemaU));
console.log('  of which product hints', est(products.join('; ')), 'place hints', est([...cities, ...areas].join('; ')), '(cities only:', est(cities.join('; ')) + ')');
console.log('understand with city hints only ≈', est(uCities.system) + est(uCities.user) + est(schemaU));
const P = (id: string) => cat.place(cat.entries.get(id)!);
for (const [label, pid, place, price] of [['olive oil Khalda +price', 'product:olive oil extra virgin', 'area:khalda', true], ['milk no place', 'product:full cream milk powder', null, false], ['tahini Madaba', 'product:tahini', 'city:madaba', false]] as const) {
  const answers = [cat.productAnswer(pid, { place: place ? P(place) : null, packText: '' })];
  const facts = factsFor(answers, { lang: 'ar', name: 'سارة', wantsPrice: price, priceOnly: false, today: '2026-10-02' });
  const c = composePrompt({ comment: 'وين بلاقيه بخلدا؟ وقديش سعره؟', facts, lang: 'ar' });
  console.log(`compose (${label}): system`, est(c.system), 'user', est(c.user), 'schema', est(JSON.stringify(COMPOSE_SCHEMA)), '=> ≈', est(c.system) + est(c.user) + est(JSON.stringify(COMPOSE_SCHEMA)));
}
const p = postPrompt({ caption: 'زيت زيتون بكر ممتاز من أرض الأردن 🫒 متوفر الآن بعبوات ١ لتر و ٢ لتر', productHints: products });
console.log('post analysis ≈', est(p.system) + est(p.user) + est(JSON.stringify(POST_SCHEMA)));
