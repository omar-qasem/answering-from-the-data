// draftBatch on its own (files storage, mock Groq): time budget → hand-off, hand-off failing → team page, reset → stop.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
rmSync('/tmp/t-batch-store', { recursive: true, force: true });
Object.assign(process.env, { LOCAL_STORE_DIR: '/tmp/t-batch-store', GROQ_API_KEY: 'gsk_test', GROQ_BASE_URL: 'http://127.0.0.1:8899/groq/openai/v1' });
const { App } = await import('../team-console/src/service');
const ctl = async (b: unknown) => (await fetch('http://127.0.0.1:8899/__control', { method: 'POST', body: JSON.stringify(b) })).json();
await ctl({ reset: true, groq: { tpm: 8000, windowMs: 60000, refill: true, latencyMs: 50 } }); // real-time bucket: the budget runs out first

const app = await App.open({ background: true });
const seeded = await app.ensureSeeded();
assert.equal(seeded.pending.length, 18);
const st = async () => (await app.state('team')) as any;

// 1. a 6-second budget: a few drafts, then the rest is handed to a "fresh job"
let handed: any[] = [];
let t0 = Date.now();
let r = await app.draftBatch(seeded.pending, { seededAt: seeded.at, budgetMs: 6000, handOff: async (rest) => ((handed = rest), true) });
console.log(`budget 6 s: drafted ${r.drafted}, handed off ${r.left} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
assert.ok(r.drafted >= 1 && r.left >= 1 && r.drafted + r.left === 18 && handed.length === r.left);
let s = await st();
assert.ok(s.posts.flatMap((p: any) => p.comments).every((c: any) => !c.beat), 'the beat is removed when the job ends');

// 2. the fresh job cannot start: the rest is flagged for the team page
r = await app.draftBatch(handed, { seededAt: seeded.at, budgetMs: 0, handOff: async () => false });
s = await st();
const flagged = s.posts.flatMap((p: any) => p.comments).filter((c: any) => c.draft && c.draft.status === 'drafting' && c.draft.via === 'page').length;
console.log(`hand-off failed: ${flagged} drafts flagged for the team page`);
assert.equal(flagged, handed.length);

// 3. a reset while a batch runs: the old batch stops at its next comment
await ctl({ groq: { windowMs: 6000, refill: true } });
const before = (await ctl({})).stats.groq_understand_comment || 0;
const fresh = await app.reset();
const old = app.draftBatch(fresh.pending, { seededAt: 'an older seed' });
const res = await old;
console.log(`stale batch: drafted ${res.drafted}, left ${res.left}`);
assert.equal(res.drafted, 0);
assert.equal((await ctl({})).stats.groq_understand_comment || 0, before, 'no AI call made by the stale batch');

// 4. the current batch drafts everything, one at a time
t0 = Date.now();
const done = await app.draftBatch(fresh.pending, { seededAt: fresh.at });
s = await st();
const ds = s.posts.flatMap((p: any) => p.comments).filter((c: any) => !c.reply).map((c: any) => c.draft);
console.log(`current batch: drafted ${done.drafted} in ${((Date.now() - t0) / 1000).toFixed(1)} s, AI-read ${ds.filter((d: any) => d.understood_by === 'ai').length}/${ds.length}`);
assert.equal(done.drafted, 18);
assert.ok(ds.every((d: any) => d.understood_by === 'ai'));
await ctl({ reset: true, groq: { windowMs: 60000, refill: true, latencyMs: 150 } });
console.log('batch OK');
