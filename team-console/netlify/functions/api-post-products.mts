// POST /api/post-products {post_id, product_ids} or {post_id, action: "analyze"}  — fix or redo what a post is about.
import { handler, json, readBody } from '../../src/http';
import { HttpError } from '../../src/service';

const run = handler({ name: 'post-products', methods: ['POST'], team: true, perMinute: 30 }, async (req, _ctx, app) => {
  const body = await readBody<{ post_id?: string; product_ids?: string[]; action?: string }>(req);
  if (!body.post_id) throw new HttpError(400, 'post_id is required.');
  const ctx = body.action === 'analyze' ? await app.analyzePost(body.post_id) : await app.setPostProducts(body.post_id, Array.isArray(body.product_ids) ? body.product_ids.map(String) : []);
  return json({ ctx });
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/post-products' };
