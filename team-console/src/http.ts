// Shared plumbing for the API functions: CORS (the feed simulator is another site), JSON in and out,
// the optional team passcode, a light rate limit, and starting background jobs.
import { App, HttpError, internalToken, type Pending } from './service';

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Team-Passcode',
  'Access-Control-Max-Age': '86400',
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...headers } });
}

export async function readBody<T = Record<string, unknown>>(req: Request, maxBytes = 6_000_000): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'The request is too large.');
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

export function teamAllowed(req: Request): boolean {
  const code = process.env.TEAM_PASSCODE;
  if (!code) return true;
  return (req.headers.get('x-team-passcode') || '') === code;
}

const hits = new Map<string, number[]>();
function limited(key: string, perMinute: number): boolean {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > perMinute;
}

export interface HandlerOpts {
  methods: string[];
  team?: boolean;
  perMinute?: number;
  name: string;
}

export function handler(opts: HandlerOpts, fn: (req: Request, ctx: any, app: App) => Promise<Response>) {
  return async (req: Request, context: any): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!opts.methods.includes(req.method)) return json({ error: 'Method not allowed.' }, 405);
    if (opts.team && !teamAllowed(req)) return json({ error: 'This page needs the team passcode.', passcode: true }, 401);
    const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'anon';
    if (opts.perMinute && limited(`${opts.name}:${ip}`, opts.perMinute)) return json({ error: 'Too many requests. Wait a minute and try again.' }, 429);
    try {
      const app = await App.open();
      return await fn(req, context, app);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error(`[${opts.name}]`, e);
      return json({ error: `Something went wrong: ${(e as Error)?.message || e}` }, 500);
    }
  };
}

// Start a background function on this same site. It answers 202 at once and keeps running for up to 15 minutes.
export async function startBackground(req: Request, app: App, name: 'draft' | 'analyze-post', payload: Record<string, unknown>): Promise<boolean> {
  try {
    const token = await internalToken(app);
    const url = new URL(`/.netlify/functions/${name}-background`, req.url).toString();
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    return res.status === 202 || res.ok;
  } catch {
    return false;
  }
}

// Several comments to draft (the demo's starting comments): one background job takes them all, a few at a time.
// If no job can be started, the team page drafts them instead.
export async function draftLater(req: Request, app: App, items: Pending[], seededAt: string | null = null): Promise<boolean> {
  if (!items.length) return true;
  if (await startBackground(req, app, 'draft', { batch: items, seeded_at: seededAt })) return true;
  await Promise.all(items.map((p) => app.markForPage(p.post_id, p.comment_id)));
  return false;
}

export async function internalAllowed(req: Request, app: App): Promise<boolean> {
  const token = await internalToken(app);
  return (req.headers.get('x-internal-token') || '') === token;
}
