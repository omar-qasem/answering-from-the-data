// POST /api/reply {post_id, comment_id, action: send|dismiss|undo, text}  — "Reply now" on the team page.
import { handler, json, readBody } from '../../src/http';

const run = handler({ name: 'reply', methods: ['POST'], team: true, perMinute: 60 }, async (req, _ctx, app) => {
  const body = await readBody<{ post_id?: string; comment_id?: string; action?: string; text?: string }>(req);
  const reply = await app.reply(body);
  return json({ reply });
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/reply' };
