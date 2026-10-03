import { readFileSync } from 'node:fs';
import { buildDataset } from '../team-console/src/ingest';
import { SearchEngine, buildAliasDocs, decide } from '../team-console/src/search';
import { understandRules, linkSpans } from '../team-console/src/understand';
const csv = readFileSync(new URL('../team-console/public/sample/pos_availability.csv', import.meta.url), 'utf8');
const ds = buildDataset(csv);
const se = new SearchEngine(ds.entries, { version: 1, docs: buildAliasDocs(ds.entries), built_at: '' }, null);
for (const m of ['رز', 'شاي', 'قهوتكم', 'زيتوون', 'حليب', 'الحلاوة', 'كيس']) {
  const r = await se.search(m, ['product', 'category']);
  console.log('search', m, '->', decide(r).status, r.slice(0, 3).map(x => `${x.entry.id} conf=${x.conf.toFixed(2)} lex=${x.how.lexical} fz=${x.how.fuzzy} ex=${x.how.exact} ct=${x.how.contained}`).join(' | '));
}
const comments = [
  'وين بلاقيه بخلدا؟', 'متوفر بالزرقا؟', 'Is this available in Aqaba?', 'يسلمو ايديكم أطيب زيت جربته 😍', 'بكم سعره؟',
  'فريكه بالسلط في؟', 'وين القاها بعمان', 'اشتريت كيس الأسبوع الماضي وكان فيه حصى 😡', 'وين بلاقي الطحينة والحلاوة بمادبا؟',
  'قهوتكم بتجنن ☕ في عندكم كمان شاي أخضر؟ وين بلاقيه بالجبيهة؟', 'Where can I buy it near Abdoun?', 'عندكم قهوه بسامح مول عبدون؟',
  'في منه الكبير ٢ كيلو بإربد؟', 'حليب بودره متوفر؟', 'وعندكم رز؟ وين بلاقيه بماركا؟', 'زيت زيتوون بالعقبه متوفر؟', '@lina.odeh شوفي هاد 😍',
  'هل الزيت عضوي؟', 'Do you deliver to Irbid?', 'how much is the big one?', 'الحلاوة متوفرة بإربد؟', 'Sweifieh?',
];
for (const c of comments) {
  const t0 = Date.now();
  const u = await understandRules(c, se);
  console.log(`${(Date.now() - t0 + 'ms').padStart(6)} ${u.intent.padEnd(15)} ${u.lang} price=${u.wants_price} prod=${JSON.stringify(u.products)} loc=${JSON.stringify(u.locations)} store=${JSON.stringify(u.stores)} post=${u.uses_post_product} | ${c}`);
}
