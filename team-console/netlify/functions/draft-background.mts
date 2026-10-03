// Background job (up to 15 minutes; the caller gets 202 at once). The AI client here is patient: on a rate limit
// it waits as long as the API asks, instead of falling back to the rules at once.
// - {post_id, comment_id, choice?}: run the ask graph for one comment and save the draft;
// - {batch: [{post_id, comment_id}, ...], seeded_at}: the demo's starting comments, drafted a few at a time
//   (one at a time on Groq's free tier). Near the time limit the rest goes to a fresh job.
import { internalAllowed, startBackground } from '../../src/http';
import { App, type Pending } from '../../src/service';

export default async (req: Request) => {
  const app = await App.open({ background: true });
  if (!(await internalAllowed(req, app))) return;
  const body = (await req.json().catch(() => ({}))) as { post_id?: string; comment_id?: string; choice?: { slot: 'product' | 'place'; id: string } | null; batch?: Pending[]; seeded_at?: string };
  if (Array.isArray(body.batch)) {
    await app.draftBatch(body.batch, { seededAt: body.seeded_at || null, handOff: (rest) => startBackground(req, app, 'draft', { batch: rest, seeded_at: body.seeded_at }) });
    return;
  }
  if (!body.post_id || !body.comment_id) return;
  await app.draftInBackground(body.post_id, body.comment_id, body.choice || null);
};

export const config = { background: true };
