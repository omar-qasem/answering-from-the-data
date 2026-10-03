// GET /api/data — what is loaded, plus the product list.  POST /api/data {action: upload|reindex|restore-sample}.
import { handler, json, readBody } from '../../src/http';
import { HttpError } from '../../src/service';

const run = handler({ name: 'data', methods: ['GET', 'POST'], team: true, perMinute: 30 }, async (req, _ctx, app) => {
  if (req.method === 'GET') {
    const b = await app.bundle();
    const products = b.engine.allEntries('product').map((e) => ({ id: e.id, name: e.name, name_ar: e.name_ar, category: (e.meta as { category?: string }).category || '' }));
    const byCity = new Map<string, { city: string; rows: number; on_shelf: number; stores: Set<string> }>();
    for (const r of b.catalog.rows) {
      const c = byCity.get(r.city_key) || { city: r.city, rows: 0, on_shelf: 0, stores: new Set<string>() };
      c.rows++;
      if (r.status !== 'out_of_stock') c.on_shelf++;
      c.stores.add(r.store_key);
      byCity.set(r.city_key, c);
    }
    const status = { in_stock: 0, low_stock: 0, out_of_stock: 0 } as Record<string, number>;
    for (const r of b.catalog.rows) status[r.status]++;
    const cities = [...byCity.values()].map((c) => ({ city: c.city, rows: c.rows, on_shelf: c.on_shelf, stores: c.stores.size })).sort((a, b) => b.rows - a.rows);
    return json({ meta: b.meta, products: products.sort((a, b) => a.name.localeCompare(b.name)), cities, status, search_note: b.semanticOff });
  }
  const body = await readBody<{ action?: string; file_name?: string; csv?: string }>(req);
  if (body.action === 'upload') return json({ meta: await app.uploadData(String(body.file_name || 'upload.csv'), String(body.csv || '')) });
  if (body.action === 'reindex') return json({ meta: await app.reindex() });
  if (body.action === 'restore-sample') return json({ meta: await app.restoreSample() });
  throw new HttpError(400, 'Unknown action.');
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/data' };
