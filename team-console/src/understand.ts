// Reading a comment without a model: intent rules plus entity linking with the same hybrid search.
// Used when no AI key is set, and as the fallback when a model call fails.
import type { EntryType } from './ingest';
import type { Lang } from './reply';
import { CONSIDER, decide, type Match, type SearchEngine } from './search';
import { hasArabic, isStopword, normalize, tokenVariants, tokens } from './text';

export type Intent = 'availability' | 'price' | 'praise' | 'complaint' | 'other_question' | 'tag_or_chat' | 'spam';

export interface Understanding {
  intent: Intent;
  lang: Lang;
  wants_price: boolean;
  products: string[];
  uses_post_product: boolean;
  pack: string | null;
  locations: string[];
  stores: string[];
  short_reply: string | null;
  reason: string;
  by: 'ai' | 'rules';
}

// Word lists are written as people type them and normalized once, so "حصى" and "حصي" both match.
function wordRe(words: string[], opts: { prefix?: boolean } = {}): RegExp {
  const alts = [...new Set(words.map((w) => normalize(w)).filter(Boolean))].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Arabic words often carry a glued prefix (و، ب، ل، ف، ال)
  const pre = opts.prefix ? '(?:و|ف|ب|ل|ال|وال|بال|لل)?' : '';
  return new RegExp(`(^|\\s)${pre}(${alts.join('|')})(?=\\s|$)`);
}

const WHERE_LIST = ['وين', 'فين', 'وينه', 'وينها', 'متوفر', 'متوفرة', 'موجود', 'موجودة', 'منه', 'منها', 'بلاقي', 'بلاقيه', 'بلاقيها', 'بلاقيهم', 'الاقي', 'القاه', 'القاها', 'القاهم', 'لاقي', 'بنلاقي', 'بيبيعو', 'بيبيعوه', 'بتبيعو', 'بيبيع', 'بتبيعوه', 'where', 'available', 'availability', 'find', 'buy', 'stock', 'sell', 'sells', 'carry', 'get'];
const WHERE = wordRe(WHERE_LIST);
const Q_WORDS = wordRe([...WHERE_LIST, 'عندكم', 'في', 'فيه', 'بكم', 'قديش', 'قداش', 'سعر', 'سعره', 'سعرها', 'هل', 'شو', 'ليش', 'كيف', 'متى', 'what', 'when', 'how', 'why', 'do', 'does', 'is', 'are', 'can', 'price', 'cost']);
const PRICE = wordRe(['بكم', 'قديش', 'قداش', 'سعر', 'سعره', 'سعرها', 'حقه', 'حقها', 'price', 'prices', 'cost', 'much']);
const COMPLAINT = wordRe(['منتهي', 'منتهية', 'خربان', 'خربانة', 'فاسد', 'فاسدة', 'سيئ', 'سيئة', 'زفت', 'معفن', 'عفن', 'حصى', 'حجار', 'حجارة', 'حشرات', 'سوس', 'ريحته', 'ريحتها', 'زعلان', 'زعلانة', 'غش', 'مغشوش', 'شكوى', 'بشتكي', 'ارجاع', 'تالف', 'تالفة', 'expired', 'rotten', 'terrible', 'worst', 'complain', 'complaint', 'refund', 'disappointed', 'broken', 'stones', 'insects', 'mould', 'mold', 'stale'], { prefix: true });
const COMPLAINT_PHRASE = /(مش طيب|مش زاكي|مش نظيف|طعمه غريب|طعمها غريب|not fresh|tastes bad|was bad)/;
const OTHER_Q = wordRe(['توصيل', 'بتوصلو', 'بتوصل', 'ديليفري', 'دليفري', 'عضوي', 'عضوية', 'مكونات', 'حلال', 'جلوتين', 'غلوتين', 'وصفة', 'طريقة', 'وظيفة', 'وظائف', 'شغل', 'عرض', 'عروض', 'خصم', 'deliver', 'delivery', 'organic', 'ingredients', 'halal', 'gluten', 'recipe', 'job', 'jobs', 'offer', 'discount', 'vegan'], { prefix: true });
const PRAISE = wordRe(['يسلمو', 'يسلم', 'تسلم', 'تسلمو', 'يعطيكم', 'روعة', 'رائع', 'رائعة', 'اطيب', 'طيب', 'طيبة', 'زاكي', 'زاكية', 'بجنن', 'بتجنن', 'بشهي', 'احلى', 'ممتاز', 'ممتازة', 'عظيم', 'حلو', 'حلوة', 'بحبه', 'بحبها', 'love', 'great', 'amazing', 'delicious', 'best', 'yummy', 'perfect', 'tasty'], { prefix: true });
const PRAISE_EMOJI = /(❤|😍|👏|🔥|😋|🤤|🥰|💯)/u;
const SPAM = /(https?:\/\/|www\.|واتساب|واتس اب|ربح سريع|follow me|تابعوني|check my|dm me for)/i;

// Split into clauses so a compliment and a question in one comment are read separately.
function clauses(text: string): { text: string; question: boolean }[] {
  return String(text || '')
    .split(/(?<=[.!?؟\n])|[،,;]|(?=\p{Extended_Pictographic})/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ text: s, question: /[?؟]/.test(s) || WHERE.test(normalize(s)) || PRICE.test(normalize(s)) }));
}

export interface Span {
  start: number;
  len: number;
  text: string;
  match: Match;
}

// Entity linking over word windows (3, 2 then 1 words): keep confident, non-overlapping hits.
export async function linkSpans(text: string, engine: SearchEngine, types: EntryType[]): Promise<Span[]> {
  const toks = tokens(text);
  const found: Span[] = [];
  for (let n = Math.min(3, toks.length); n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const w = toks.slice(i, i + n);
      if (isStopword(w[0]) || isStopword(w[w.length - 1])) continue;
      const res = await engine.search(w.join(' '), types, 5, null);
      const d = decide(res);
      const top = res[0];
      if (!top) continue;
      // every word of the window must belong to the matched name (no extra words), except a confident typo match
      const aliasToks = tokens(top.alias).filter((x) => !isStopword(x));
      const aliasVars = new Set(aliasToks.flatMap((x) => tokenVariants(x)));
      const winVars = new Set(w.flatMap((x) => tokenVariants(x)));
      const tight = w.every((x) => isStopword(x) || tokenVariants(x).some((v) => aliasVars.has(v)));
      const typo = n === 1 && top.conf >= 0.85;
      if (!tight && !typo) continue;
      // and the window must cover enough of the name: "الكبير" alone is not "سوق السلط الكبير"
      const covered = aliasToks.length ? aliasToks.filter((x) => tokenVariants(x).some((v) => winVars.has(v))).length / aliasToks.length : 0;
      if (!typo && covered < (top.entry.type === 'store' ? 0.6 : 0.5)) continue;
      if (d.status === 'match' || (d.status === 'ambiguous' && top.conf >= CONSIDER)) found.push({ start: i, len: n, text: w.join(' '), match: top });
    }
  }
  found.sort((a, b) => b.len - a.len || b.match.conf - a.match.conf);
  const taken = new Set<number>();
  let out: Span[] = [];
  for (const s of found) {
    const idx = Array.from({ length: s.len }, (_, k) => s.start + k);
    if (idx.some((k) => taken.has(k))) continue;
    idx.forEach((k) => taken.add(k));
    out.push(s);
  }
  // a category window that hides named products ("الطحينة والحلاوة") gives way to the products
  const cats = out.filter((s) => s.match.entry.type === 'category' && s.len > 1);
  for (const c of cats) {
    const inner = found.filter((s) => s.match.entry.type === 'product' && s.start >= c.start && s.start + s.len <= c.start + c.len);
    const picked: Span[] = [];
    for (const s of inner.sort((a, b) => b.len - a.len || b.match.conf - a.match.conf)) {
      if (picked.some((p) => p.start < s.start + s.len && s.start < p.start + p.len)) continue;
      picked.push(s);
    }
    if (picked.length) out = [...out.filter((s) => s !== c), ...picked];
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function understandRules(text: string, engine: SearchEngine): Promise<Understanding> {
  const raw = String(text || '').trim();
  const t = normalize(raw);
  const lang: Lang = hasArabic(raw) ? 'ar' : 'en';
  const base: Understanding = { intent: 'tag_or_chat', lang, wants_price: false, products: [], uses_post_product: true, pack: null, locations: [], stores: [], short_reply: null, reason: '', by: 'rules' };
  if (!t) return { ...base, reason: 'Only emojis or empty text.' };
  if (SPAM.test(raw)) return { ...base, intent: 'spam', reason: 'Looks like a link or an advert.' };
  if (/^@\S+/.test(raw) && !/[?؟]/.test(raw)) return { ...base, intent: 'tag_or_chat', reason: 'Tags a friend; nothing to answer.' };

  const parts = clauses(raw);
  const qParts = parts.filter((p) => p.question);
  const scope = qParts.length ? qParts.map((p) => p.text).join(' ، ') : raw;
  const prodSpans = await linkSpans(scope, engine, ['product', 'category']);
  // "الحجم الوسط" / "العبوة الكبيرة" are sizes, not the Central region or a shop called "...الكبير"
  const placeScope = normalize(scope).replace(/(^|\s)(ال)?(حجم|عبوه|باكيت|كيس|قياس|size|pack)\s+(ال)?(وسط|وسطاني|متوسط|كبير|كبيره|صغير|صغيره|عائلي)(?=\s|$)/g, ' ');
  const placeSpans = await linkSpans(placeScope, engine, ['store', 'area', 'city', 'region']);
  const products = prodSpans.map((s) => s.text);
  const stores = placeSpans.filter((s) => s.match.entry.type === 'store').map((s) => s.text);
  const locations = placeSpans.filter((s) => s.match.entry.type !== 'store').map((s) => s.text);
  const wantsPrice = PRICE.test(t);
  const isQuestion = qParts.length > 0;
  const common = { ...base, products, stores, locations, wants_price: wantsPrice, pack: raw, uses_post_product: products.length === 0 };

  if (COMPLAINT.test(t) || COMPLAINT_PHRASE.test(t)) return { ...common, intent: 'complaint', reason: 'Mentions a problem with a product or a shop.' };
  if (isQuestion) {
    const whereWords = WHERE.test(t);
    if (OTHER_Q.test(t) && !whereWords) return { ...common, intent: 'other_question', reason: 'A question about something other than where to buy.' };
    if (wantsPrice && !whereWords && !locations.length && !stores.length) return { ...common, intent: 'price', reason: 'Asks about the price.' };
    if (whereWords || products.length || locations.length || stores.length || /(^|\s)(في|فيه|عندكم)(\s|$)/.test(t)) return { ...common, intent: 'availability', reason: 'Asks where to find a product.' };
    return { ...common, intent: 'other_question', reason: 'A question that is not about where to buy.' };
  }
  if (PRAISE.test(t) || PRAISE_EMOJI.test(raw)) return { ...common, intent: 'praise', reason: 'A compliment with no question.' };
  if (locations.length || stores.length) return { ...common, intent: 'availability', reason: 'Names a place, read as a where-to-buy question.' };
  if (products.length && raw.length < 40) return { ...common, intent: 'availability', reason: 'Names a product, read as a where-to-buy question.' };
  return { ...common, intent: 'tag_or_chat', reason: 'Nothing to answer.' };
}

// Post analysis without a model: products named in the caption.
export async function postProductsRules(caption: string, engine: SearchEngine): Promise<Match[]> {
  const spans = await linkSpans(caption, engine, ['product']);
  const seen = new Set<string>();
  const out: Match[] = [];
  for (const s of spans) {
    if (seen.has(s.match.entry.id)) continue;
    seen.add(s.match.entry.id);
    out.push(s.match);
  }
  return out;
}
