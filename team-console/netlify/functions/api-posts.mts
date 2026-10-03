// POST /api/posts {caption, image: data URL}  — the brand publishes a post from the feed simulator.
import { handler, json, readBody, startBackground } from '../../src/http';

const run = handler({ name: 'posts', methods: ['POST'], perMinute: 8 }, async (req, _ctx, app) => {
  const body = await readBody<{ caption?: string; image?: string }>(req);
  const post = await app.createPost(body);
  const started = await startBackground(req, app, 'analyze-post', { post_id: post.id });
  if (!started && !app.llm) await app.analyzePost(post.id); // without AI the analysis is instant
  else if (!started) await app.markForPage(post.id); // the team page runs the analysis right away
  return json({ post, analysis: started ? 'background' : app.llm ? 'later' : 'done' }, 201);
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/posts' };
