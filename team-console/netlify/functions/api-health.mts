// GET /api/health — engine, AI, storage and data status (no secrets).  POST {action: "ai-check"} makes one tiny call to the AI model.
import { handler, json, readBody, teamAllowed } from '../../src/http';

const run = handler({ name: 'health', methods: ['GET', 'POST'], perMinute: 60 }, async (req, _ctx, app) => {
  if (req.method === 'POST') {
    if (!teamAllowed(req)) return json({ error: 'This page needs the team passcode.', passcode: true }, 401);
    const body = await readBody<{ action?: string }>(req);
    if (body.action === 'ai-check') return json(await app.aiCheck());
  }
  return json(await app.health());
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/health' };
