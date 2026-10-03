// GET /api/state?view=feed|team&v=<version>  — everything both pages show. Seeds the demo on first use.
import { draftLater, handler, json, teamAllowed } from '../../src/http';

const run = handler({ name: 'state', methods: ['GET'], perMinute: 240 }, async (req, _ctx, app) => {
  const url = new URL(req.url);
  const view = url.searchParams.get('view') === 'team' ? 'team' : 'feed';
  if (view === 'team' && !teamAllowed(req)) return json({ error: 'This page needs the team passcode.', passcode: true }, 401);
  const seeded = await app.ensureSeeded();
  if (seeded.pending.length) await draftLater(req, app, seeded.pending, seeded.at);
  return json(await app.state(view, url.searchParams.get('v')));
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/state' };
