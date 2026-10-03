// The exact part of the answer: once search has said WHICH product and WHERE, this filters the table.
// No model is involved here, so the shops, statuses, prices and visit dates in a reply always come from the data.
import type { Dataset, Entry, Row, Status } from './ingest';
import { normalize } from './text';

export type PlaceType = 'store' | 'area' | 'city' | 'region';
export interface Place {
  type: PlaceType;
  key: string;
  name: string;
  name_ar: string;
}

export interface PackInfo {
  sku: string;
  pack: string;
  amount: number | null; // in g, ml or units
  unit: 'g' | 'ml' | 'unit' | null;
}

export interface StoreItem {
  sku: string;
  pack: string;
  status: Status;
  qty: number | null;
  price: number | null;
}

export interface StoreLine {
  store_key: string;
  store_id: string;
  store_name: string;
  store_name_ar: string;
  store_type: string;
  area: string;
  area_ar: string;
  area_key: string;
  city: string;
  city_ar: string;
  city_key: string;
  region_key: string;
  date: string;
  rep: string;
  items: StoreItem[]; // the product's packs at this shop (after the pack filter)
  best: Status; // best status across those packs
}

export interface ScopeStep {
  place: Place | null; // null = the whole country
  stores: number; // shops in this scope that carry the product in the data
  available: number; // of which have it on the shelf (in stock or low)
}

export interface ProductAnswer {
  product: { id: string; key: string; name: string; name_ar: string };
  packs: PackInfo[];
  pack: PackInfo | null; // the pack the customer asked for, when we could tell
  pack_asked: string | null; // what they wrote, e.g. "2 كيلو"
  pack_missing: boolean; // they asked for a size we do not sell
  requested: Place | null;
  used: Place | null; // where the listed shops are (null = whole country)
  widened: boolean;
  steps: ScopeStep[];
  available: StoreLine[]; // shops to name, best first
  out_in_requested: StoreLine[]; // shops in the requested place where it was out at the last visit
  by_city: { city_key: string; city: string; city_ar: string; stores: number }[];
  price: { min: number; max: number; stores: number } | null; // set when there is one pack in play
  prices: { sku: string; pack: string; min: number; max: number; stores: number }[]; // per pack
  dates: { min: string; max: string } | null;
}

const STATUS_RANK: Record<Status, number> = { in_stock: 0, low_stock: 1, out_of_stock: 2 };
export const isOnShelf = (s: Status) => s !== 'out_of_stock';

// ---------- packs ----------
export function packAmount(pack: string): { amount: number | null; unit: PackInfo['unit'] } {
  const t = normalize(pack);
  const m = t.match(/(\d+(?:\.\d+)?)\s*([a-z؀-ۿ]+)?/);
  if (!m) return { amount: null, unit: null };
  const n = Number(m[1]);
  const u = (m[2] || '').toLowerCase();
  if (/^(kg|kilo|كيلو|كغ|كجم|كيلوغرام|كيلوجرام)/.test(u)) return { amount: n * 1000, unit: 'g' };
  if (/^(g|gm|gr|gram|غ|غم|غرام|جرام|جم)/.test(u)) return { amount: n, unit: 'g' };
  if (/^(ml|مل|ملي|مليلتر)/.test(u)) return { amount: n, unit: 'ml' };
  if (/^(l|lt|ltr|liter|litre|لتر|ليتر)/.test(u)) return { amount: n * 1000, unit: 'ml' };
  if (/^(bag|bags|pcs|كيس|اكياس|ظرف|حبه)/.test(u)) return { amount: n, unit: 'unit' };
  return { amount: n, unit: null };
}

export function packInfo(sku: string, pack: string): PackInfo {
  return { sku, pack, ...packAmount(pack) };
}

const BIG = /(^|\s)(ال)?(كبير|كبيره|اكبر|عائلي|عيلة|عيله)(\s|$)|large|big|biggest|family|largest/;
const SMALL = /(^|\s)(ال)?(صغير|صغيره|اصغر)(\s|$)|small|smallest|mini/;
const MID = /(^|\s)(ال)?(وسط|متوسط|وسطاني|نص نص)(\s|$)|medium|mid/;

// Find which pack the text asks for: a written size ("1.8 كيلو", "900g", "نص كيلو") or a word (the big one).
export function resolvePack(text: string, packs: PackInfo[]): { pack: PackInfo | null; asked: string | null; missing: boolean } {
  const t = normalize(text);
  if (!t) return { pack: null, asked: null, missing: false };
  let asked: { amount: number; unit: PackInfo['unit']; raw: string } | null = null;
  const re = /(\d+(?:\.\d+)?)\s*(kg|kilo|كيلو|كغ|كجم|g|gm|gr|gram|غرام|جرام|غم|غ|جم|ml|مل|ملي|l|lt|ltr|liter|litre|لتر|ليتر|bags|bag|كيس|اكياس)(?![a-z؀-ۿ])/g;
  const m = re.exec(t);
  if (m) {
    const a = packAmount(`${m[1]} ${m[2]}`);
    if (a.amount !== null) asked = { amount: a.amount, unit: a.unit, raw: m[0] };
  } else if (/(^|\s)(نص|نصف) (كيلو|كغ)/.test(t)) asked = { amount: 500, unit: 'g', raw: 'نص كيلو' };
  else if (/(^|\s)(ربع) (كيلو|كغ)/.test(t)) asked = { amount: 250, unit: 'g', raw: 'ربع كيلو' };
  else if (/(^|\s)(كيلو|كيلوين)(\s|$)/.test(t)) asked = { amount: /كيلوين/.test(t) ? 2000 : 1000, unit: 'g', raw: /كيلوين/.test(t) ? 'كيلوين' : 'كيلو' };
  else if (/(^|\s)(لتر|ليتر)(\s|$)/.test(t)) asked = { amount: 1000, unit: 'ml', raw: 'لتر' };

  const sized = packs.filter((p) => p.amount !== null).sort((a, b) => a.amount! - b.amount!);
  if (asked) {
    const same = sized.filter((p) => p.unit === asked!.unit);
    let best: PackInfo | null = null;
    let diff = Infinity;
    for (const p of same) {
      const d = Math.abs(p.amount! - asked.amount) / asked.amount;
      if (d < diff) {
        diff = d;
        best = p;
      }
    }
    if (best && diff <= 0.3) return { pack: best, asked: asked.raw, missing: false };
    return { pack: null, asked: asked.raw, missing: true };
  }
  if (sized.length > 1) {
    if (BIG.test(t)) return { pack: sized[sized.length - 1], asked: 'largest', missing: false };
    if (SMALL.test(t)) return { pack: sized[0], asked: 'smallest', missing: false };
    if (MID.test(t) && sized.length >= 3) return { pack: sized[Math.floor(sized.length / 2)], asked: 'middle', missing: false };
  }
  return { pack: null, asked: null, missing: false };
}

// ---------- catalog ----------
export class Catalog {
  readonly rows: Row[];
  readonly entries: Map<string, Entry>;
  private byProduct = new Map<string, Row[]>();

  constructor(ds: Pick<Dataset, 'rows' | 'entries'>) {
    this.rows = ds.rows;
    this.entries = new Map(ds.entries.map((e) => [e.id, e]));
    for (const r of ds.rows) {
      if (!this.byProduct.has(r.product_key)) this.byProduct.set(r.product_key, []);
      this.byProduct.get(r.product_key)!.push(r);
    }
  }

  entry(type: string, key: string): Entry | undefined {
    return this.entries.get(`${type}:${key}`);
  }

  arName(type: string, key: string, fallback: string): string {
    return this.entry(type, key)?.name_ar || fallback;
  }

  place(e: Entry): Place {
    return { type: e.type as PlaceType, key: e.key, name: e.name, name_ar: e.name_ar };
  }

  // shop -> its area (or city when the area is the city) -> city -> region -> whole country
  parent(p: Place): Place | null {
    const e = this.entry(p.type, p.key);
    const m = (e?.meta || {}) as Record<string, string>;
    const asPlace = (type: PlaceType, key?: string): Place | null => {
      if (!key) return null;
      const pe = this.entry(type, key);
      return pe ? this.place(pe) : null;
    };
    if (p.type === 'store') return asPlace('area', m.area_key) || asPlace('city', m.city_key) || asPlace('region', m.region_key);
    if (p.type === 'area') return asPlace('city', m.city_key) || asPlace('region', m.region_key);
    if (p.type === 'city') return asPlace('region', m.region_key);
    return null;
  }

  inPlace(r: Row, p: Place | null): boolean {
    if (!p) return true;
    if (p.type === 'store') return r.store_key === p.key;
    if (p.type === 'area') return r.area_key === p.key;
    if (p.type === 'city') return r.city_key === p.key;
    return r.region_key === p.key;
  }

  storesIn(p: Place | null): number {
    return new Set(this.rows.filter((r) => this.inPlace(r, p)).map((r) => r.store_key)).size;
  }

  packsOf(productKey: string): PackInfo[] {
    const list = this.byProduct.get(productKey) || [];
    const seen = new Map<string, PackInfo>();
    for (const r of list) if (!seen.has(r.sku)) seen.set(r.sku, packInfo(r.sku, r.pack_size));
    return [...seen.values()].sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0));
  }

  private lines(productKey: string, skus: Set<string> | null): StoreLine[] {
    const byStore = new Map<string, StoreLine>();
    for (const r of this.byProduct.get(productKey) || []) {
      if (skus && !skus.has(r.sku)) continue;
      let line = byStore.get(r.store_key);
      if (!line) {
        line = {
          store_key: r.store_key,
          store_id: r.store_id,
          store_name: r.store_name,
          store_name_ar: this.arName('store', r.store_key, r.store_name),
          store_type: r.store_type,
          area: r.area,
          area_ar: this.arName('area', r.area_key, '') || this.arName('city', r.area_key, r.area),
          area_key: r.area_key,
          city: r.city,
          city_ar: this.arName('city', r.city_key, r.city),
          city_key: r.city_key,
          region_key: r.region_key,
          date: r.date,
          rep: r.rep,
          items: [],
          best: 'out_of_stock',
        };
        byStore.set(r.store_key, line);
      }
      if (r.date > line.date) line.date = r.date;
      line.items.push({ sku: r.sku, pack: r.pack_size, status: r.status, qty: r.qty, price: r.price });
      if (STATUS_RANK[r.status] < STATUS_RANK[line.best]) line.best = r.status;
    }
    for (const l of byStore.values()) l.items.sort((a, b) => (packAmount(a.pack).amount ?? 0) - (packAmount(b.pack).amount ?? 0));
    return [...byStore.values()];
  }

  // Where is this product on the shelf, starting from the place the customer named and widening if needed.
  productAnswer(productId: string, opts: { place?: Place | null; packText?: string; pack?: PackInfo | null } = {}): ProductAnswer {
    const pe = this.entries.get(productId);
    if (!pe || pe.type !== 'product') throw new Error(`Unknown product ${productId}`);
    const packs = this.packsOf(pe.key);
    let pack: PackInfo | null = opts.pack ?? null;
    let packAsked: string | null = pack ? pack.pack : null;
    let packMissing = false;
    if (!pack && opts.packText && packs.length) {
      const r = resolvePack(opts.packText, packs);
      pack = r.pack;
      packAsked = r.asked;
      packMissing = r.missing && packs.length > 0;
    }
    const all = this.lines(pe.key, pack ? new Set([pack.sku]) : null);
    const requested = opts.place ?? null;
    const steps: ScopeStep[] = [];
    let used: Place | null = requested;
    let pool: StoreLine[] = [];
    for (;;) {
      const inScope = all.filter((l) => this.lineIn(l, used));
      const avail = inScope.filter((l) => isOnShelf(l.best));
      steps.push({ place: used, stores: inScope.length, available: avail.length });
      if (avail.length || used === null) {
        pool = avail;
        break;
      }
      used = this.parent(used);
    }
    const anchor = requested ? all.find((l) => this.lineIn(l, requested)) || null : null;
    const anchorPlace = requested;
    const proximity = (l: StoreLine): number => {
      if (!anchorPlace) return 0;
      const ref = anchor;
      if (this.lineIn(l, anchorPlace)) return 0;
      if (ref && l.area_key === ref.area_key) return 1;
      const areaE = anchorPlace.type === 'area' ? this.entry('area', anchorPlace.key) : null;
      const storeE = anchorPlace.type === 'store' ? this.entry('store', anchorPlace.key) : null;
      const cityKey = anchorPlace.type === 'city' ? anchorPlace.key : ((areaE || storeE)?.meta as Record<string, string> | undefined)?.city_key;
      if (cityKey && l.city_key === cityKey) return 2;
      const regionKey = anchorPlace.type === 'region' ? anchorPlace.key : (this.entry(anchorPlace.type, anchorPlace.key)?.meta as Record<string, string> | undefined)?.region_key;
      if (regionKey && l.region_key === regionKey) return 3;
      return 4;
    };
    pool.sort((a, b) => proximity(a) - proximity(b) || STATUS_RANK[a.best] - STATUS_RANK[b.best] || b.date.localeCompare(a.date) || totalQty(b) - totalQty(a) || a.store_name.localeCompare(b.store_name));
    const outInRequested = requested ? all.filter((l) => this.lineIn(l, requested) && !isOnShelf(l.best)).sort((a, b) => b.date.localeCompare(a.date)) : [];

    const cityCount = new Map<string, { city_key: string; city: string; city_ar: string; stores: number }>();
    for (const l of pool) {
      const c = cityCount.get(l.city_key) || { city_key: l.city_key, city: l.city, city_ar: l.city_ar, stores: 0 };
      c.stores++;
      cityCount.set(l.city_key, c);
    }
    const byCity = [...cityCount.values()].sort((a, b) => b.stores - a.stores || a.city.localeCompare(b.city));

    // shelf prices per pack (a range, since each shop sets its own), from the shops we are about to name
    const priceSrc = pool.length ? pool : all.filter((l) => this.lineIn(l, used));
    const perPack = new Map<string, { sku: string; pack: string; min: number; max: number; stores: number }>();
    for (const l of priceSrc) {
      for (const i of l.items) {
        if (i.price === null || (pool.length && !isOnShelf(i.status))) continue;
        const p = perPack.get(i.sku) || { sku: i.sku, pack: i.pack, min: i.price, max: i.price, stores: 0 };
        p.min = Math.min(p.min, i.price);
        p.max = Math.max(p.max, i.price);
        p.stores++;
        perPack.set(i.sku, p);
      }
    }
    const prices = [...perPack.values()].sort((a, b) => (packAmount(a.pack).amount ?? 0) - (packAmount(b.pack).amount ?? 0));
    const price = prices.length === 1 ? { min: prices[0].min, max: prices[0].max, stores: prices[0].stores } : null;
    const dateSrc = pool.length ? pool : outInRequested.length ? outInRequested : all.filter((l) => this.lineIn(l, used));
    const ds = dateSrc.map((l) => l.date).sort();
    return {
      product: { id: pe.id, key: pe.key, name: pe.name, name_ar: pe.name_ar },
      packs,
      pack,
      pack_asked: packAsked,
      pack_missing: packMissing,
      requested,
      used,
      widened: requested !== null && (used === null || used.key !== requested.key || used.type !== requested.type),
      steps,
      available: pool,
      out_in_requested: outInRequested,
      by_city: byCity,
      price,
      prices,
      dates: ds.length ? { min: ds[0], max: ds[ds.length - 1] } : null,
    };
  }

  private lineIn(l: StoreLine, p: Place | null): boolean {
    if (!p) return true;
    if (p.type === 'store') return l.store_key === p.key;
    if (p.type === 'area') return l.area_key === p.key;
    if (p.type === 'city') return l.city_key === p.key;
    return l.region_key === p.key;
  }
}

function totalQty(l: StoreLine): number {
  return l.items.reduce((s, i) => s + (i.qty && isOnShelf(i.status) ? i.qty : 0), 0);
}
