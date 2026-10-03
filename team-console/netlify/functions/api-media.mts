// GET /api/media/:id — images of posts published from the feed simulator.
import { CORS, handler } from '../../src/http';

const run = handler({ name: 'media', methods: ['GET'], perMinute: 600 }, async (_req, ctx, app) => {
  const img = await app.media(String(ctx?.params?.id || ''));
  if (!img) return new Response('Not found', { status: 404, headers: CORS });
  const body = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength) as ArrayBuffer;
  return new Response(body, { status: 200, headers: { ...CORS, 'Content-Type': img.type, 'Cache-Control': 'public, max-age=31536000, immutable' } });
});

export default async (req: Request, context: any) => run(req, context);

export const config = { path: '/api/media/:id' };
