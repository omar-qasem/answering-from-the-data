// POST /api/reset — put the demo back to its five posts and their comments (the data file is kept).
import { draftLater, handler, json } from '../../src/http';

const run = handler({ name: 'reset', methods: ['POST'], team: true, perMinute: 6 }, async (req, _ctx, app) => {
  const seeded = await app.reset();
  const started = await draftLater(req, app, seeded.pending, seeded.at);
  return json({ ok: true, pending: seeded.pending.length, background: started ? seeded.pending.length : 0 });
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/reset' };
