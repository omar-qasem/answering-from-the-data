// Turning query results into a reply: formatting, the no-AI templates, the facts handed to the model,
// the "based on" list shown to the team, and the fact check run on every AI reply.
import { MONTHS_AR, MONTHS_EN } from './aliases';
import type { Catalog, ProductAnswer, StoreLine } from './query';
import { isOnShelf } from './query';
import type { Status } from './ingest';
import { normalize } from './text';

export type Lang = 'ar' | 'en';
export type ReplyKind = 'answer' | 'clarify' | 'courtesy' | 'handoff' | 'none';

const MAX_SHOPS = 3;

// ---------- formatting ----------
export function fmtDate(iso: string, lang: Lang): string {
  const [, m, d] = iso.split('-').map(Number);
  return lang === 'ar' ? `${d} ${MONTHS_AR[m - 1]}` : `${d} ${MONTHS_EN[m - 1]}`;
}

export function fmtDateLong(iso: string, lang: Lang): string {
  return `${fmtDate(iso, lang)} ${iso.slice(0, 4)}`;
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso.slice(0, 10)) - Date.parse(fromIso.slice(0, 10))) / 86400000);
}

export function fmtMoney(n: number): string {
  return n.toFixed(2);
}

export function fmtPrice(n: number, lang: Lang): string {
  return lang === 'ar' ? `${fmtMoney(n)} دينار` : `JOD ${fmtMoney(n)}`;
}

export function fmtPriceRange(min: number, max: number, lang: Lang): string {
  if (Math.abs(min - max) < 0.005) return fmtPrice(min, lang);
  return lang === 'ar' ? `بين ${fmtMoney(min)} و${fmtMoney(max)} دينار` : `JOD ${fmtMoney(min)}–${fmtMoney(max)}`;
}

export function fmtPack(pack: string, lang: Lang): string {
  if (lang === 'en') return pack;
  return pack
    .replace(/\bkg\b/i, 'كغ')
    .replace(/\bml\b/i, 'مل')
    .replace(/\bg\b/i, 'غ')
    .replace(/\bL\b/, 'لتر')
    .replace(/\bbags\b/i, 'كيس');
}

const STATUS_TEXT: Record<Lang, Record<Status, string>> = {
  ar: { in_stock: 'متوفر', low_stock: 'كمية قليلة', out_of_stock: 'غير متوفر' },
  en: { in_stock: 'in stock', low_stock: 'low stock', out_of_stock: 'out of stock' },
};
export const statusText = (s: Status, lang: Lang) => STATUS_TEXT[lang][s];

// Arabic agreement: "متوفر" or "متوفرة", from the first word of the Arabic name.
export function isFeminine(nameAr: string): boolean {
  const first = String(nameAr || '').trim().split(/\s+/)[0] || '';
  return /ة$/.test(first);
}

const EN_NAMES: Record<string, string> = {
  'olive oil extra virgin': 'extra virgin olive oil',
  'sunflower cooking oil': 'sunflower oil',
  'corn cooking oil': 'corn oil',
  'turkish coffee ground': 'ground Turkish coffee',
  'halawa plain': 'plain halawa',
  'black tea loose': 'loose black tea',
  'chickpeas canned': 'canned chickpeas',
  'fava beans canned': 'canned fava beans',
  'sweet corn canned': 'canned sweet corn',
  'white rice egyptian': 'Egyptian white rice',
  'bulgur coarse': 'coarse bulgur',
  'spaghetti pasta': 'spaghetti',
  'vermicelli pasta': 'vermicelli',
};
export function enName(p: { key: string; name: string }): string {
  return EN_NAMES[p.key] || p.name.toLowerCase();
}

// "محل ثاني"، "محلين ثانيين"، "5 محلات ثانية"، "12 محل ثاني"
function moreShopsAr(n: number): string {
  if (n === 1) return 'محل ثاني';
  if (n === 2) return 'محلين ثانيين';
  if (n <= 10) return `${n} محلات ثانية`;
  return `${n} محل ثاني`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function firstName(display: string): string {
  return String(display || '').trim().split(/\s+/)[0] || '';
}

// ---------- the no-AI templates ----------
interface Ctx {
  lang: Lang;
  name: string;
  wantsPrice: boolean;
  priceOnly?: boolean; // the customer only asked the price: lead with it
}

function placeAr(p: { type: string; name_ar: string } | null): string {
  if (!p) return 'الأردن';
  if (p.type === 'region') return `منطقة ${p.name_ar}`;
  return p.name_ar;
}

// "بـ" glued to the place: بخلدا، بالزرقاء، بإربد
const biAr = (name: string) => `ب${name}`;

function shopLabel(l: StoreLine, lang: Lang, withArea: boolean): string {
  const name = lang === 'ar' ? l.store_name_ar : l.store_name;
  if (!withArea) return name;
  const area = lang === 'ar' ? l.area_ar : l.area;
  if (!area || normalize(name).includes(normalize(area))) return name;
  return `${name} – ${area}`;
}

function packsAt(l: StoreLine, lang: Lang): string {
  const on = l.items.filter((i) => isOnShelf(i.status)).map((i) => fmtPack(i.pack, lang));
  return lang === 'ar' ? on.join(' و') : on.join(' & ');
}

function bullet(l: StoreLine, a: ProductAnswer, c: Ctx, withArea: boolean): string {
  const multi = a.packs.length > 1 && !a.pack;
  const packs = multi ? packsAt(l, c.lang) : '';
  const low = l.best === 'low_stock';
  if (c.lang === 'ar') {
    const bits = [packs ? `${packs}` : '', low ? 'الكمية قليلة' : '', `آخر زيارة ${fmtDate(l.date, 'ar')}`].filter(Boolean);
    return `• ${shopLabel(l, 'ar', withArea)} (${bits.join('، ')})`;
  }
  const bits = [packs, low ? 'low stock' : '', `last visit ${fmtDate(l.date, 'en')}`].filter(Boolean);
  return `• ${shopLabel(l, 'en', withArea)} (${bits.join(', ')})`;
}

function priceLine(a: ProductAnswer, c: Ctx): string {
  if (!c.wantsPrice || !a.prices.length) return '';
  if (a.prices.length === 1) {
    const p = a.prices[0];
    return c.lang === 'ar' ? `السعر على الرف ${fmtPriceRange(p.min, p.max, 'ar')}${p.min !== p.max ? ' حسب المحل' : ''}.` : `Shelf price: ${fmtPriceRange(p.min, p.max, 'en')}${p.min !== p.max ? ' depending on the shop' : ''}.`;
  }
  const parts = a.prices.map((p) => `${fmtPack(p.pack, c.lang)}: ${fmtPriceRange(p.min, p.max, c.lang)}`);
  return c.lang === 'ar' ? `الأسعار على الرف: ${parts.join('، ')}.` : `Shelf prices: ${parts.join('; ')}.`;
}

function productPhrase(a: ProductAnswer, lang: Lang): string {
  const base = lang === 'ar' ? a.product.name_ar : enName(a.product);
  if (a.pack && a.packs.length > 1) return lang === 'ar' ? `${base} عبوة ${fmtPack(a.pack.pack, 'ar')}` : `${base} (${a.pack.pack})`;
  return base;
}

function blockForProduct(a: ProductAnswer, c: Ctx): string[] {
  const ar = c.lang === 'ar';
  const fem = isFeminine(a.product.name_ar);
  const avail = ar ? (fem ? 'متوفرة' : 'متوفر') : 'available';
  const find = fem ? 'بتلاقيها' : 'بتلاقيه';
  const P = productPhrase(a, c.lang);
  const out: string[] = [];
  if (a.pack_missing && a.pack_asked) {
    const list = a.packs.map((p) => fmtPack(p.pack, c.lang)).join(ar ? ' و' : ' and ');
    out.push(ar ? `ما عنا عبوة ${a.pack_asked} من ${a.product.name_ar}، العبوات اللي عنا: ${list}.` : `We don't make a ${a.pack_asked} pack of ${enName(a.product)}; it comes in ${list}.`);
  }
  const shops = a.available.slice(0, MAX_SHOPS);
  const more = a.available.length - shops.length;
  const req = a.requested;
  const reqName = req ? (ar ? placeAr(req) : req.name) : '';
  const usedName = a.used ? (ar ? placeAr(a.used) : a.used.name) : ar ? 'الأردن' : 'Jordan';
  const widenArea = !a.used || a.used.type !== 'store';

  // a price question: the shelf price (a range across shops), with the visit dates it comes from
  if (c.priceOnly && a.prices.length) {
    const where = req ? (ar ? ` ${biAr(reqName)}` : ` in ${reqName}`) : '';
    const span = a.dates ? (a.dates.min === a.dates.max ? fmtDate(a.dates.max, c.lang) : ar ? `${fmtDate(a.dates.min, 'ar')} – ${fmtDate(a.dates.max, 'ar')}` : `${fmtDate(a.dates.min, 'en')}–${fmtDate(a.dates.max, 'en')}`) : '';
    const range = span ? (ar ? ` (آخر زيارات مندوبينا: ${span})` : ` (our reps' latest visits: ${span})`) : '';
    if (a.prices.length === 1 || a.pack) {
      const p = a.pack ? a.prices.find((x) => x.sku === a.pack!.sku) || a.prices[0] : a.prices[0];
      const varies = Math.abs(p.min - p.max) >= 0.005;
      out.push(ar ? `سعر ${P} على الرف${where} ${fmtPriceRange(p.min, p.max, 'ar')}${varies ? ' حسب المحل' : ''}${range}.` : `${cap(P)} sells for ${fmtPriceRange(p.min, p.max, 'en')} on the shelf${where}${varies ? ', depending on the shop' : ''}${range}.`);
    } else {
      const parts = a.prices.map((p) => `${fmtPack(p.pack, c.lang)}: ${fmtPriceRange(p.min, p.max, c.lang)}`);
      out.push(ar ? `أسعار ${P} على الرف${where}: ${parts.join('، ')} حسب المحل${range}.` : `Shelf prices for ${P}${where}: ${parts.join('; ')}, depending on the shop${range}.`);
    }
    return out;
  }

  // nothing on any shelf we know of
  if (!a.available.length) {
    const latest = a.dates ? fmtDate(a.dates.max, c.lang) : '';
    out.push(
      ar
        ? `للأسف ${P} مش ${avail} حالياً بأي محل من المحلات اللي زارها مندوبينا${latest ? ` (آخر زيارة ${latest})` : ''}. رح نوصّل ملاحظتك لفريق المبيعات 🙏`
        : `Sorry, ${P} isn't on the shelf at any shop our reps visited${latest ? ` (latest visit ${latest})` : ''}. We'll pass this on to our sales team 🙏`,
    );
    return out;
  }

  // the customer named a shop
  if (req && req.type === 'store') {
    const shop = a.out_in_requested[0];
    if (!a.widened) {
      const l = a.available[0];
      const low = l.best === 'low_stock';
      out.push(
        ar
          ? `حسب آخر زيارة لمندوبنا لـ${l.store_name_ar} (${fmtDate(l.date, 'ar')})، ${P} ${avail}${low ? ' بس الكمية قليلة' : ''}${a.packs.length > 1 && !a.pack ? ` (${packsAt(l, 'ar')})` : ''}.`
          : `At ${l.store_name} (last visit ${fmtDate(l.date, 'en')}), ${P} was in stock${low ? ', but running low' : ''}${a.packs.length > 1 && !a.pack ? ` (${packsAt(l, 'en')})` : ''}.`,
      );
    } else {
      const visit = shop ? ` (${fmtDate(shop.date, c.lang)})` : '';
      out.push(ar ? `حسب آخر زيارة لـ${req.name_ar}${visit} ${P} كان ${fem ? 'خالصة' : 'خالص'}، بس ${find} قريب عند:` : `At ${req.name}${visit} ${P} was out of stock, but you can find it nearby at:`);
      for (const l of shops) out.push(bullet(l, a, c, true));
    }
  } else if (!req) {
    // no place: a short national picture, then ask where they are
    if (a.available.length <= MAX_SHOPS) {
      out.push(ar ? `${P} ${avail} حالياً عند:` : `${cap(P)} is currently available at:`);
      for (const l of shops) out.push(bullet(l, a, c, true));
    } else {
      const top = a.by_city.slice(0, 3);
      const cities = top.map((t) => (ar ? `${t.city_ar} (${t.stores})` : `${t.city} (${t.stores})`));
      const list = ar ? cities.join(' و') : cities.length > 1 ? `${cities.slice(0, -1).join(', ')} and ${cities[cities.length - 1]}` : cities[0];
      const range = a.dates ? (ar ? ` حسب زيارات مندوبينا (${fmtDate(a.dates.min, 'ar')} – ${fmtDate(a.dates.max, 'ar')})` : ` based on our reps' visits (${fmtDate(a.dates.min, 'en')}–${fmtDate(a.dates.max, 'en')})`) : '';
      out.push(ar ? `${P} ${avail} حالياً بـ${a.available.length} محل${range}، أكثرها ${biAr(list)}.` : `${cap(P)} is on the shelf at ${a.available.length} shops${range}, mostly in ${list}.`);
      const pl = priceLine(a, c);
      if (pl) out.push(pl);
      out.push(ar ? `احكيلنا وين منطقتك لنقلك أقرب محل 😊` : `Tell us your area and we'll point you to the nearest shop 😊`);
      return out;
    }
  } else if (!a.widened) {
    out.push(ar ? `${P} ${avail} ${biAr(reqName)} عند:` : `${cap(P)} is in stock in ${reqName} at:`);
    for (const l of shops) out.push(bullet(l, a, c, req.type !== 'area'));
    if (more > 0) out.push(ar ? `وكمان عند ${moreShopsAr(more)} ${biAr(reqName)}.` : `…and ${more} more shop${more > 1 ? 's' : ''} in ${reqName}.`);
  } else {
    const first = a.steps[0];
    const outDate = a.out_in_requested[0] ? fmtDate(a.out_in_requested[0].date, c.lang) : '';
    const lead = ar
      ? first.stores > 0
        ? `حسب آخر زيارة لمندوبينا${outDate ? ` (${outDate})` : ''}، ${P} مش ${avail} حالياً ${biAr(reqName)}`
        : `ما عنا محل ${biAr(reqName)} بيبيع ${P} حسب بياناتنا`
      : first.stores > 0
        ? `Our reps' last visit${outDate ? ` (${outDate})` : ''} didn't find ${P} on the shelf in ${reqName}`
        : `We don't have a shop in ${reqName} that carries ${P}`;
    out.push(ar ? `${lead}، بس ${find} ${a.used ? biAr(usedName) : 'بمحلات ثانية'} عند:` : `${lead}, but you can find it ${a.used ? `in ${usedName}` : 'elsewhere'} at:`);
    for (const l of shops) out.push(bullet(l, a, c, widenArea));
  }
  const pl = priceLine(a, c);
  if (pl) out.push(pl);
  return out;
}

export function templateAnswer(answers: ProductAnswer[], c: Ctx): string {
  const ar = c.lang === 'ar';
  const hello = ar ? `أهلاً${c.name ? ` ${c.name}` : ''} 👋` : `Hi${c.name ? ` ${c.name}` : ''}! 👋`;
  const blocks = answers.map((a) => blockForProduct(a, c).join('\n'));
  const anyShop = !c.priceOnly && answers.some((a) => a.available.length && (a.requested || a.available.length <= MAX_SHOPS));
  const tail = anyShop ? (ar ? 'يُفضّل تتأكد من المحل قبل ما تروح 🙏' : 'Worth checking with the shop before you go 🙏') : '';
  return [hello, ...blocks, tail].filter(Boolean).join('\n');
}

export function templateClarify(opts: { lang: Lang; name: string; options: string[]; askPlace: boolean; slot: 'product' | 'place' }): string {
  const { lang, name, options, askPlace } = opts;
  const o = options.slice(0, 3);
  if (lang === 'ar') {
    const q = o.length ? `قصدك ${o.join(' ولا ')}؟` : 'شو المنتج اللي بتسأل عنه؟';
    return `أهلاً${name ? ` ${name}` : ''} 😊 ${q}${askPlace ? ' وبأي منطقة انت؟' : ''}`;
  }
  const q = o.length ? `Do you mean ${o.length > 2 ? `${o.slice(0, -1).join(', ')} or ${o[o.length - 1]}` : o.join(' or ')}?` : 'Which product are you asking about?';
  return `Hi${name ? ` ${name}` : ''}! ${q}${askPlace ? ' And which area are you in?' : ''}`;
}

export function templateCourtesy(lang: Lang, name: string): string {
  return lang === 'ar' ? `يسلم قلبك${name ? ` ${name}` : ''} 🙏 بالصحة والهنا!` : `Thank you so much${name ? `, ${name}` : ''}! 🙏 Enjoy!`;
}

export function templateHandoff(lang: Lang, name: string, why: 'complaint' | 'question'): string {
  if (why === 'complaint') {
    return lang === 'ar'
      ? `بنعتذر منك${name ? ` ${name}` : ''} على هالتجربة 🙏 ممكن تبعتلنا رسالة خاصة فيها اسم المحل وتاريخ الشراء لنتابع الموضوع معك فوراً؟`
      : `We're really sorry about this${name ? `, ${name}` : ''} 🙏 Could you send us a direct message with the shop name and purchase date so we can sort it out right away?`;
  }
  return lang === 'ar' ? `أهلاً${name ? ` ${name}` : ''}، سؤال حلو! رح نتأكد ونرد عليك بأقرب وقت 🙏` : `Great question${name ? `, ${name}` : ''}! We'll check and get back to you shortly 🙏`;
}

// ---------- what the team sees under each draft ----------
export interface BasisItem {
  product: string;
  product_ar: string;
  store_id: string;
  store_name: string;
  store_name_ar: string;
  area: string;
  city: string;
  pack: string;
  status: Status;
  qty: number | null;
  price: number | null;
  date: string;
  rep: string;
  role: 'named' | 'out_in_requested';
}

export function basisOf(answers: ProductAnswer[]): BasisItem[] {
  const out: BasisItem[] = [];
  for (const a of answers) {
    const named = a.requested || a.available.length <= MAX_SHOPS ? a.available.slice(0, MAX_SHOPS) : a.available.slice(0, 5);
    const push = (l: StoreLine, role: BasisItem['role']) => {
      for (const i of l.items) {
        out.push({ product: a.product.name, product_ar: a.product.name_ar, store_id: l.store_id, store_name: l.store_name, store_name_ar: l.store_name_ar, area: l.area, city: l.city, pack: i.pack, status: i.status, qty: i.qty, price: i.price, date: l.date, rep: l.rep, role });
      }
    };
    for (const l of named) push(l, 'named');
    for (const l of a.out_in_requested.slice(0, 2)) push(l, 'out_in_requested');
  }
  return out;
}

// ---------- the facts the model may use (and nothing else) ----------
export function factsFor(answers: ProductAnswer[], opts: { lang: Lang; name: string; wantsPrice: boolean; priceOnly?: boolean; today: string }) {
  return {
    today: opts.today,
    question: opts.priceOnly ? 'price only: lead with the shelf price range; do not list shops' : 'where to buy',
    reply_language: opts.lang === 'ar' ? 'Arabic (Jordanian dialect, friendly)' : 'English',
    customer_first_name: opts.name || null,
    asked_about_price: opts.wantsPrice,
    products: answers.map((a) => ({
      name_ar: a.product.name_ar,
      name_en: enName(a.product),
      grammatical_gender_ar: isFeminine(a.product.name_ar) ? 'feminine' : 'masculine',
      packs_we_make: a.packs.map((p) => p.pack),
      pack_asked: a.pack_asked,
      pack_answered: a.pack?.pack ?? null,
      pack_asked_does_not_exist: a.pack_missing,
      requested_place: a.requested ? { type: a.requested.type, name_ar: a.requested.name_ar, name_en: a.requested.name } : null,
      shops_listed_are_in: a.used ? { type: a.used.type, name_ar: a.used.name_ar, name_en: a.used.name } : 'the whole country',
      widened_from_requested_place: a.widened,
      requested_place_has_shops_that_carry_it: a.requested ? a.steps[0].stores > 0 : null,
      shops: a.available.slice(0, a.requested || a.available.length <= MAX_SHOPS ? MAX_SHOPS : 0).map((l) => ({
        name_ar: l.store_name_ar,
        name_en: l.store_name,
        area_ar: l.area_ar,
        area_en: l.area,
        city_ar: l.city_ar,
        city_en: l.city,
        last_visit: l.date,
        last_visit_ar: fmtDate(l.date, 'ar'),
        last_visit_en: fmtDate(l.date, 'en'),
        packs: l.items.map((i) => ({ pack: i.pack, status: statusText(i.status, 'en'), ...(opts.wantsPrice && i.price !== null ? { shelf_price_jod: Number(fmtMoney(i.price)) } : {}) })),
      })),
      other_shops_with_it_in_same_scope: Math.max(0, a.available.length - MAX_SHOPS),
      total_shops_with_it_on_shelf: a.available.length,
      out_of_stock_at_last_visit_in_requested_place: a.out_in_requested.slice(0, 2).map((l) => ({ name_ar: l.store_name_ar, name_en: l.store_name, last_visit_ar: fmtDate(l.date, 'ar'), last_visit_en: fmtDate(l.date, 'en') })),
      top_cities: a.requested ? [] : a.by_city.slice(0, 3).map((c) => ({ city_ar: c.city_ar, city_en: c.city, shops: c.stores })),
      visit_dates_range: a.dates ? { from_ar: fmtDate(a.dates.min, 'ar'), to_ar: fmtDate(a.dates.max, 'ar'), from_en: fmtDate(a.dates.min, 'en'), to_en: fmtDate(a.dates.max, 'en') } : null,
      shelf_price_range_jod: opts.wantsPrice ? a.prices.map((p) => ({ pack: p.pack, min: Number(fmtMoney(p.min)), max: Number(fmtMoney(p.max)) })) : [],
    })),
  };
}

// ---------- fact check for AI replies ----------
const MONTH_RE_AR = new RegExp(`(\\d{1,2})\\s*(${MONTHS_AR.map((m) => normalize(m)).join('|')})`, 'g');
const MONTH_RE_EN = new RegExp(`(\\d{1,2})\\s*(${MONTHS_EN.map((m) => m.toLowerCase()).join('|')})[a-z]*|(${MONTHS_EN.map((m) => m.toLowerCase()).join('|')})[a-z]*\\s*(\\d{1,2})`, 'g');

export function checkReply(text: string, answers: ProductAnswer[], catalog: Catalog, opts: { wantsPrice: boolean; priceOnly?: boolean }): string[] {
  const problems: string[] = [];
  const t = String(text || '').trim();
  if (!t) return ['The reply is empty.'];
  if (t.length > 900) problems.push('The reply is too long for a comment.');
  const norm = ` ${normalize(t)} `;

  const allowedStores = new Set<string>();
  const allowedDates = new Set<string>();
  const allowedPrices = new Set<string>();
  for (const a of answers) {
    const named = a.requested || a.available.length <= MAX_SHOPS ? a.available.slice(0, MAX_SHOPS) : [];
    for (const l of [...named, ...a.out_in_requested.slice(0, 2)]) {
      allowedStores.add(l.store_key);
      allowedDates.add(l.date.slice(5));
      for (const i of l.items) if (i.price !== null) allowedPrices.add(fmtMoney(i.price));
    }
    if (a.requested?.type === 'store') allowedStores.add(a.requested.key);
    if (a.dates) {
      allowedDates.add(a.dates.min.slice(5));
      allowedDates.add(a.dates.max.slice(5));
    }
    for (const p of a.prices) {
      allowedPrices.add(fmtMoney(p.min));
      allowedPrices.add(fmtMoney(p.max));
    }
  }

  // every shop the reply names must be one the answer is based on
  for (const e of catalog.entries.values()) {
    if (e.type !== 'store' || allowedStores.has(e.key)) continue;
    const hit = [e.name, e.name_ar].map((n) => normalize(n)).find((n) => n.split(' ').length >= 2 && norm.includes(` ${n} `));
    if (hit) problems.push(`Names a shop that is not in the data for this answer: ${e.name}.`);
  }

  // every date must be a real visit date from the answer
  const seen: string[] = [];
  let m: RegExpExecArray | null;
  MONTH_RE_AR.lastIndex = 0;
  while ((m = MONTH_RE_AR.exec(norm))) {
    const month = MONTHS_AR.map((x) => normalize(x)).indexOf(m[2]) + 1;
    seen.push(`${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`);
  }
  MONTH_RE_EN.lastIndex = 0;
  const lower = t.toLowerCase();
  while ((m = MONTH_RE_EN.exec(lower))) {
    const day = Number(m[1] ?? m[4]);
    const mon = (m[2] ?? m[3]).slice(0, 3);
    const month = MONTHS_EN.map((x) => x.toLowerCase()).indexOf(mon) + 1;
    if (month > 0) seen.push(`${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  for (const iso of t.match(/\d{4}-\d{2}-\d{2}/g) || []) seen.push(iso.slice(5));
  for (const d of seen) if (!allowedDates.has(d)) problems.push(`Mentions a date that is not a visit date in the data (${d}).`);

  const namesShops = !opts.priceOnly && answers.some((a) => a.available.length && (a.requested || a.available.length <= MAX_SHOPS));
  if (namesShops && !seen.length) problems.push('Does not say when the shelf was checked (the visit date).');

  // prices must be shelf prices from the data, and only when asked
  const priceLike = t.match(/\d+[.٫]\d{1,2}/g) || [];
  for (const p of priceLike) {
    const v = Number(p.replace('٫', '.'));
    const isPack = answers.some((a) => a.packs.some((pk) => pk.pack.startsWith(p)));
    if (isPack) continue;
    if (!allowedPrices.has(fmtMoney(v))) problems.push(`Mentions a number that is not a shelf price in the data (${p}).`);
    else if (!opts.wantsPrice) problems.push('Mentions a price the customer did not ask for.');
  }
  return [...new Set(problems)];
}
