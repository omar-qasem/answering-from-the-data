// Ingest: turns an uploaded CSV into a clean availability table plus the catalogs (the "chunks")
// that the hybrid search matches against: one entry per product, shop, area, city, region and category.
import { AREA_ALIASES, CATEGORY_ALIASES, CITY_ALIASES, PRODUCT_ALIASES, REGION_ALIASES, STORE_WORD_ALIASES } from './aliases';
import { hasArabic, normalize } from './text';

export type Status = 'in_stock' | 'low_stock' | 'out_of_stock';
export type EntryType = 'product' | 'store' | 'area' | 'city' | 'region' | 'category';

export interface Row {
  store_key: string;
  store_id: string;
  store_name: string;
  store_type: string;
  area: string;
  area_key: string;
  city: string;
  city_key: string;
  region: string;
  region_key: string;
  sku: string;
  product_name: string;
  product_key: string;
  category: string;
  pack_size: string;
  qty: number | null;
  status: Status;
  price: number | null;
  date: string; // YYYY-MM-DD, the sales rep's visit
  rep: string;
}

export interface Entry {
  id: string; // `${type}:${key}`
  type: EntryType;
  key: string;
  name: string;
  name_ar: string;
  aliases: string[];
  meta: Record<string, unknown>;
}

export interface DatasetMeta {
  file_name: string;
  uploaded_at: string;
  row_count: number;
  stores: number;
  products: number;
  skus: number;
  areas: number;
  cities: number;
  date_min: string;
  date_max: string;
  warnings: string[];
}

export interface Dataset {
  rows: Row[];
  entries: Entry[];
  meta: DatasetMeta;
}

export class IngestError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join(' '));
    this.problems = problems;
  }
}

// ---------- CSV ----------
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v.trim() !== '')) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) out.push(row);
  return out;
}

const HEADER_SYNONYMS: Record<string, string[]> = {
  store_id: ['store_id', 'shop_id', 'outlet_id', 'pos_id', 'store_code'],
  store_name: ['store_name', 'store', 'shop', 'shop_name', 'outlet', 'outlet_name', 'pos', 'pos_name', 'point_of_sale'],
  store_type: ['store_type', 'channel', 'outlet_type', 'shop_type'],
  area: ['area', 'district', 'neighborhood', 'neighbourhood', 'zone', 'locality'],
  city: ['city', 'governorate', 'town'],
  region: ['region'],
  sku: ['sku', 'item_code', 'product_code', 'code', 'barcode'],
  product_name: ['product_name', 'product', 'item', 'item_name', 'product_description'],
  category: ['category', 'product_category', 'family'],
  pack_size: ['pack_size', 'size', 'pack', 'weight', 'volume'],
  qty: ['quantity_on_shelf', 'quantity', 'qty', 'on_shelf', 'stock_qty', 'units'],
  status: ['availability_status', 'status', 'availability', 'stock_status', 'in_stock'],
  price: ['shelf_price_jod', 'price', 'shelf_price', 'price_jod', 'unit_price'],
  date: ['last_updated', 'date', 'visit_date', 'updated', 'last_visit', 'updated_at', 'visited_on'],
  rep: ['sales_rep', 'rep', 'salesman', 'agent', 'merchandiser'],
};

function headerKey(h: string): string {
  return String(h ?? '').trim().toLowerCase().replace(/[\s\-.]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

export function mapHeaders(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const keys = headers.map(headerKey);
  for (const [field, names] of Object.entries(HEADER_SYNONYMS)) {
    const idx = keys.findIndex((k) => names.includes(k));
    if (idx >= 0) map[field] = idx;
  }
  return map;
}

export function parseStatus(raw: string, qty: number | null): Status | null {
  const t = normalize(raw);
  if (t) {
    if (/(^|\s)(out|no|none|false|0)(\s|$)|غير|نفد|نفذ|منتهي/.test(t)) return 'out_of_stock';
    if (/low|limited|قليل|محدود/.test(t)) return 'low_stock';
    if (/in stock|^in$|yes|true|available|متوفر|موجود|^1$/.test(t)) return 'in_stock';
  }
  if (qty !== null && Number.isFinite(qty)) {
    if (qty <= 0) return 'out_of_stock';
    if (qty <= 5) return 'low_stock';
    return 'in_stock';
  }
  return null;
}

export function parseDate(raw: string): string | null {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  let y: number, m: number, d: number;
  let mt = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (mt) {
    y = +mt[1];
    m = +mt[2];
    d = +mt[3];
  } else {
    mt = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!mt) return null;
    const a = +mt[1];
    const b = +mt[2];
    y = +mt[3] < 100 ? 2000 + +mt[3] : +mt[3];
    if (a > 12) [d, m] = [a, b];
    else if (b > 12) [m, d] = [a, b];
    else [d, m] = [a, b]; // day first, as written in Jordan
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

function num(raw: string): number | null {
  const t = String(raw ?? '').replace(/[^\d.\-]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const titleKey = (s: string) => normalize(s);
export const storeKeyOf = (s: string) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '-').replace(/^-|-$/g, '');

// ---------- Arabic names for shops ----------
const GENERIC_STORE_WORDS: Record<string, string> = {
  supermarket: 'سوبرماركت',
  hypermarket: 'هايبرماركت',
  'mini market': 'ميني ماركت',
  market: 'سوق',
  grocery: 'بقالة',
  mall: 'مول',
  main: 'الرئيسي',
  central: 'المركزي',
  family: 'العائلي',
  grand: 'الكبير',
};

// The shop type goes first in Arabic: "Al Salam Market Sweifieh" -> "سوق السلام الصويفية".
const STORE_TYPE_WORDS: [RegExp, string][] = [
  [/\bmini market\b/, 'ميني ماركت'],
  [/\bsupermarket\b/, 'سوبرماركت'],
  [/\bhypermarket\b/, 'هايبرماركت'],
  [/\bgrocery\b/, 'بقالة'],
  [/\bmarket\b/, 'سوق'],
];

export function storeArabicName(name: string, areaKey: string): string {
  let lower = name.toLowerCase();
  let typeAr = '';
  if (!/\bnour market\b/.test(lower)) {
    for (const [re, ar] of STORE_TYPE_WORDS) {
      if (re.test(lower)) {
        typeAr = ar;
        lower = lower.replace(re, ' ');
        break;
      }
    }
  }
  const rest = translateStoreWords(lower);
  if (!rest || /[a-z]/.test(rest)) return '';
  let out = typeAr ? `${typeAr} ${rest}` : rest;
  if (typeAr === 'بقالة') out = out.replace(/(الرئيسي|المركزي|الكبير|العائلي)(?=\s|$)/g, '$1ة');
  void areaKey;
  return out.replace(/\s+/g, ' ').trim();
}

function translateStoreWords(name: string): string {
  let t = ' ' + name + ' ';
  t = t.replace(/\bal (mafraq|karak|salt|azraq)\b/g, (_m, w: string) => ({ mafraq: 'المفرق', karak: 'الكرك', salt: 'السلط', azraq: 'الأزرق' } as Record<string, string>)[w]);
  const dict: [string, string][] = [
    ...Object.entries(STORE_WORD_ALIASES),
    ...Object.entries(AREA_ALIASES).map(([k, v]) => [k, v.ar] as [string, string]),
    ...Object.entries(CITY_ALIASES).map(([k, v]) => [k, v.ar] as [string, string]),
    ...Object.entries(GENERIC_STORE_WORDS),
  ];
  dict.sort((a, b) => b[0].length - a[0].length);
  for (const [en, ar] of dict) t = t.replace(new RegExp(`(^|\\s)${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s)`, 'g'), `$1${ar}`);
  // a few shop names use other spellings of their area
  t = t.replace(/\bsweifieh\b/g, 'الصويفية').replace(/\bwaibdeh\b/g, 'اللويبدة').replace(/\bjubaiha\b/g, 'الجبيهة').replace(/\bjabal nasr\b/g, 'جبل النصر').replace(/\bramtha\b/g, 'الرمثا').replace(/\bhashemiya\b/g, 'الهاشمية').replace(/\bnaour\b/g, 'ناعور');
  return t.replace(/\s+/g, ' ').trim();
}

// ---------- main ----------
export function buildDataset(csvText: string, fileName = 'pos_availability.csv', uploadedAt = new Date().toISOString()): Dataset {
  const table = parseCsv(csvText);
  if (table.length < 2) throw new IngestError(['The file has no data rows.']);
  const headers = table[0];
  const map = mapHeaders(headers);
  const problems: string[] = [];
  if (map.store_name === undefined) problems.push('Missing a store or shop name column (for example store_name).');
  if (map.product_name === undefined) problems.push('Missing a product name column (for example product_name).');
  if (map.area === undefined && map.city === undefined) problems.push('Missing an area or city column.');
  if (map.date === undefined) problems.push('Missing a visit date column (for example last_updated).');
  if (map.status === undefined && map.qty === undefined) problems.push('Missing an availability column (availability_status or quantity_on_shelf).');
  if (problems.length) throw new IngestError(problems);

  const warnings: string[] = [];
  const get = (r: string[], f: string) => (map[f] === undefined ? '' : String(r[map[f]] ?? '').trim());
  const latest = new Map<string, Row>();
  let badDates = 0;
  let badStatus = 0;
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const storeName = get(r, 'store_name');
    const productName = get(r, 'product_name');
    if (!storeName || !productName) continue;
    const qty = num(get(r, 'qty'));
    const status = parseStatus(get(r, 'status'), qty);
    const date = parseDate(get(r, 'date'));
    if (!date) {
      badDates++;
      continue;
    }
    if (!status) {
      badStatus++;
      continue;
    }
    const area = get(r, 'area') || get(r, 'city');
    const city = get(r, 'city') || area;
    const region = get(r, 'region');
    const storeId = get(r, 'store_id');
    const pack = get(r, 'pack_size');
    const row: Row = {
      store_key: storeKeyOf(storeId || storeName),
      store_id: storeId || storeName,
      store_name: storeName,
      store_type: get(r, 'store_type'),
      area,
      area_key: titleKey(area),
      city,
      city_key: titleKey(city),
      region,
      region_key: titleKey(region),
      sku: get(r, 'sku') || `${productName} ${pack}`.trim(),
      product_name: productName,
      product_key: titleKey(productName),
      category: get(r, 'category'),
      pack_size: pack,
      qty,
      status,
      price: num(get(r, 'price')),
      date,
      rep: get(r, 'rep'),
    };
    const k = `${row.store_key}|${titleKey(row.sku)}`;
    const prev = latest.get(k);
    if (!prev || prev.date <= row.date) latest.set(k, row); // keep the latest visit for each shop and item
  }
  if (badDates) warnings.push(`${badDates} row(s) skipped: the visit date could not be read.`);
  if (badStatus) warnings.push(`${badStatus} row(s) skipped: no availability status or quantity.`);
  const rows = [...latest.values()];
  if (!rows.length) throw new IngestError(['No usable rows: check the date and availability columns.', ...warnings]);

  const entries = buildEntries(rows);
  const dates = rows.map((r) => r.date).sort();
  const meta: DatasetMeta = {
    file_name: fileName,
    uploaded_at: uploadedAt,
    row_count: rows.length,
    stores: new Set(rows.map((r) => r.store_key)).size,
    products: new Set(rows.map((r) => r.product_key)).size,
    skus: new Set(rows.map((r) => titleKey(r.sku))).size,
    areas: new Set(rows.map((r) => r.area_key)).size,
    cities: new Set(rows.map((r) => r.city_key)).size,
    date_min: dates[0],
    date_max: dates[dates.length - 1],
    warnings,
  };
  return { rows, entries, meta };
}

function uniq(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of list) {
    const n = normalize(a);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(a);
  }
  return out;
}

export function buildEntries(rows: Row[]): Entry[] {
  const entries: Entry[] = [];
  const byProduct = new Map<string, Row[]>();
  const byStore = new Map<string, Row>();
  const areas = new Map<string, Row>();
  const cities = new Map<string, Row>();
  const regions = new Map<string, Row>();
  const categories = new Map<string, Row>();
  for (const r of rows) {
    if (!byProduct.has(r.product_key)) byProduct.set(r.product_key, []);
    byProduct.get(r.product_key)!.push(r);
    if (!byStore.has(r.store_key)) byStore.set(r.store_key, r);
    if (r.area_key && !areas.has(r.area_key)) areas.set(r.area_key, r);
    if (r.city_key && !cities.has(r.city_key)) cities.set(r.city_key, r);
    if (r.region_key && !regions.has(r.region_key)) regions.set(r.region_key, r);
    if (r.category && !categories.has(titleKey(r.category))) categories.set(titleKey(r.category), r);
  }
  for (const [key, list] of byProduct) {
    const cur = PRODUCT_ALIASES[key];
    const packs = [...new Map(list.map((r) => [titleKey(r.sku), { sku: r.sku, pack: r.pack_size }])).values()];
    entries.push({
      id: `product:${key}`,
      type: 'product',
      key,
      name: list[0].product_name,
      name_ar: cur?.ar || list[0].product_name,
      aliases: uniq([list[0].product_name, ...(cur?.aliases || [])]),
      meta: { category: list[0].category, packs },
    });
  }
  for (const [key, r] of categories) {
    const cur = CATEGORY_ALIASES[key];
    entries.push({ id: `category:${key}`, type: 'category', key, name: r.category, name_ar: cur?.ar || r.category, aliases: uniq([r.category, ...(cur?.aliases || [])]), meta: {} });
  }
  for (const [key, r] of regions) {
    const cur = REGION_ALIASES[key];
    entries.push({ id: `region:${key}`, type: 'region', key, name: r.region, name_ar: cur?.ar || r.region, aliases: uniq([r.region, ...(cur?.aliases || [])]), meta: {} });
  }
  for (const [key, r] of cities) {
    const cur = CITY_ALIASES[key];
    entries.push({ id: `city:${key}`, type: 'city', key, name: r.city, name_ar: cur?.ar || r.city, aliases: uniq([r.city, ...(cur?.aliases || [])]), meta: { region_key: r.region_key } });
  }
  for (const [key, r] of areas) {
    if (cities.has(key)) continue; // a city used as its own area
    const cur = AREA_ALIASES[key];
    entries.push({
      id: `area:${key}`,
      type: 'area',
      key,
      name: r.area,
      name_ar: cur?.ar || r.area,
      aliases: uniq([r.area, ...(cur?.aliases || [])]),
      meta: { city_key: r.city_key, region_key: r.region_key },
    });
  }
  for (const [key, r] of byStore) {
    const ar = storeArabicName(r.store_name, r.area_key);
    entries.push({
      id: `store:${key}`,
      type: 'store',
      key,
      name: r.store_name,
      name_ar: ar || r.store_name,
      aliases: uniq([r.store_name, ...(ar ? [ar] : [])]),
      meta: { area_key: r.area_key, city_key: r.city_key, region_key: r.region_key, store_type: r.store_type },
    });
  }
  return entries;
}

export function entriesMissingArabic(entries: Entry[]): Entry[] {
  return entries.filter((e) => ['product', 'area', 'city', 'category'].includes(e.type) && !e.aliases.some((a) => hasArabic(a)));
}
