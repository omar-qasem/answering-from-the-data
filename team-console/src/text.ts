// Text helpers shared by ingest, search and the graphs.
// Arabic and English text is normalized the same way everywhere, so "الزرقاء", "الزرقا" and "بالزرقا" meet.

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

export function normalize(input: string): string {
  let t = String(input ?? '').toLowerCase();
  t = t.replace(DIACRITICS, '');
  t = t
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ء/g, '');
  t = t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  t = t.replace(/٫/g, '.').replace(/[،؛؟]/g, ' ');
  t = t.replace(/[^\p{L}\p{N}.\s]/gu, ' ');
  t = t.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

const ARABIC = /[؀-ۿ]/;

export function hasArabic(s: string): boolean {
  return ARABIC.test(s || '');
}

// Arabic words carry prefixes: و (and), ب ل ك ف (prepositions) and ال (the). Index and query every form.
export function tokenVariants(token: string): string[] {
  const out = new Set<string>([token]);
  if (!ARABIC.test(token)) return [...out];
  let t = token;
  if (t.length > 3 && t.startsWith('و')) {
    t = t.slice(1);
    out.add(t);
  }
  if (t.startsWith('لل') && t.length > 3) out.add(t.slice(2));
  if (t.length > 3 && /^[بلكف]/.test(t)) {
    const u = t.slice(1);
    out.add(u);
    if (u.startsWith('ال') && u.length > 3) out.add(u.slice(2));
  }
  if (t.startsWith('ال') && t.length > 3) out.add(t.slice(2));
  return [...out];
}

export function tokens(s: string): string[] {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

export function tokensWithVariants(s: string): string[] {
  const out: string[] = [];
  for (const tok of tokens(s)) for (const v of tokenVariants(tok)) out.push(v);
  return out;
}

// Words that never identify a product, a place or a shop on their own.
export const STOPWORDS = new Set(
  [
    'وين', 'فين', 'في', 'فيه', 'فيها', 'عندكم', 'عندك', 'عنا', 'عندنا', 'متوفر', 'متوفره', 'موجود', 'موجوده', 'بدي', 'بدنا', 'ممكن',
    'شو', 'ايش', 'هل', 'كم', 'بكم', 'سعر', 'سعره', 'سعرها', 'الله', 'يعطيكم', 'العافيه', 'لو', 'سمحت', 'سمحتو', 'من', 'على', 'عن',
    'الى', 'الي', 'لا', 'ما', 'مش', 'او', 'ولا', 'هاد', 'هاي', 'هذا', 'هذه', 'هو', 'هي', 'اياه', 'اياها', 'بلاقي', 'بلاقيه', 'بلاقيها',
    'الاقي', 'لاقي', 'نلاقي', 'اشتري', 'بشتري', 'اجيب', 'بجيب', 'بنفع', 'حدا', 'اقرب', 'محل', 'محلات', 'سوبرماركت', 'منطقه', 'مدينه',
    'يا', 'مرحبا', 'اهلا', 'السلام', 'عليكم', 'شكرا', 'لسا', 'هلا', 'هسا', 'اليوم', 'حاليا', 'صار', 'كان', 'ان', 'انه', 'كل', 'شي',
    'the', 'a', 'an', 'is', 'are', 'it', 'this', 'that', 'where', 'can', 'could', 'i', 'we', 'you', 'buy', 'find', 'get', 'in', 'at',
    'near', 'of', 'to', 'for', 'and', 'or', 'do', 'does', 'have', 'has', 'any', 'available', 'stock', 'please', 'hi', 'hello', 'how',
    'much', 'price', 'what', 'which', 'shop', 'store', 'there', 'now', 'today', 'still', 'my', 'me', 'thanks', 'thank',
  ].map((w) => normalize(w)),
);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

// 32-bit FNV-1a, used for hashed character vectors.
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function uid(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function clip(s: string, max: number): string {
  const t = String(s ?? '').trim();
  return t.length > max ? t.slice(0, max) : t;
}
