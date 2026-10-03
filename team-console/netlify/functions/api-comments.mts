// POST /api/comments {post_id, persona_id, text}  — a customer comments from the feed simulator.
import { handler, json, readBody, startBackground } from '../../src/http';

const run = handler({ name: 'comments', methods: ['POST'], perMinute: 30 }, async (req, _ctx, app) => {
  const body = await readBody<{ post_id?: string; persona_id?: string; text?: string }>(req);
  const comment = await app.createComment(body);
  const started = await startBackground(req, app, 'draft', { post_id: comment.post_id, comment_id: comment.id });
  if (!started && !app.llm) await app.draft(comment.post_id, comment.id); // without AI the draft takes milliseconds
  else if (!started) await app.markForPage(comment.post_id, comment.id); // the team page drafts it right away
  return json({ comment, drafting: started ? 'background' : app.llm ? 'later' : 'done' }, 201);
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/comments' };
