// POST /api/draft {post_id, comment_id, choice?: {slot, id}}  — (re)draft one reply now, optionally with the team's pick.
import { handler, json, readBody } from '../../src/http';
import { HttpError } from '../../src/service';

const run = handler({ name: 'draft', methods: ['POST'], team: true, perMinute: 40 }, async (req, _ctx, app) => {
  const body = await readBody<{ post_id?: string; comment_id?: string; choice?: { slot?: string; id?: string } | null }>(req);
  if (!body.post_id || !body.comment_id) throw new HttpError(400, 'post_id and comment_id are required.');
  const c = body.choice;
  const choice = c && (c.slot === 'product' || c.slot === 'place') && typeof c.id === 'string' ? { slot: c.slot, id: c.id } : null;
  const draft = await app.draft(body.post_id, body.comment_id, choice as { slot: 'product' | 'place'; id: string } | null);
  return json({ draft });
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/draft' };
