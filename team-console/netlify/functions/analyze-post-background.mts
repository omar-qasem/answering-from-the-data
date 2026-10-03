// Background job: run the post graph once for a new post (find its products and link them to the catalog).
import { internalAllowed } from '../../src/http';
import { App } from '../../src/service';

export default async (req: Request) => {
  const app = await App.open({ background: true });
  if (!(await internalAllowed(req, app))) return;
  const body = (await req.json().catch(() => ({}))) as { post_id?: string };
  if (!body.post_id) return;
  await app.analyzeInBackground(body.post_id);
};

export const config = { background: true };
