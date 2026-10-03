// Storage: Netlify Blobs on Netlify (site-wide stores that survive redeploys).
// For local runs, set LOCAL_STORE_DIR to keep everything in plain files instead.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface KV {
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
  setJSONIfNew(key: string, value: unknown): Promise<boolean>; // atomic: false when the key already exists
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ key: string; etag: string }[]>;
  getBytes(key: string): Promise<{ data: Uint8Array; type: string } | null>;
  setBytes(key: string, data: Uint8Array, type: string): Promise<void>;
}

export interface Stores {
  kind: 'netlify-blobs' | 'files';
  social: KV; // posts, post analysis, comments, drafts, replies
  catalog: KV; // the availability table and its search index
  media: KV; // images of posts made in the simulator
}

// ---------- Netlify Blobs ----------
function blobsKV(store: any): KV {
  return {
    async getJSON<T>(key: string) {
      return ((await store.get(key, { type: 'json' })) ?? null) as T | null;
    },
    async setJSON(key, value) {
      await store.setJSON(key, value);
    },
    async setJSONIfNew(key, value) {
      const r = await store.set(key, JSON.stringify(value), { onlyIfNew: true });
      return r?.modified !== false;
    },
    async delete(key) {
      await store.delete(key);
    },
    async list(prefix) {
      const res = await store.list(prefix ? { prefix } : {});
      return (res?.blobs || []).map((b: { key: string; etag: string }) => ({ key: b.key, etag: String(b.etag || '') }));
    },
    async getBytes(key) {
      const r = await store.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!r || !r.data) return null;
      return { data: new Uint8Array(r.data as ArrayBuffer), type: String(r.metadata?.type || 'application/octet-stream') };
    },
    async setBytes(key, data, type) {
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      await store.set(key, buf, { metadata: { type } });
    },
  };
}

// ---------- plain files (local runs and tests) ----------
function fileKV(root: string): KV {
  const enc = (key: string) => path.join(root, ...key.split('/').map((p) => encodeURIComponent(p)));
  const dec = (rel: string) => rel.split(path.sep).map((p) => decodeURIComponent(p)).join('/');
  async function walk(dir: string, base: string, out: { key: string; etag: string }[]) {
    let items: import('node:fs').Dirent[] = [];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) await walk(full, base, out);
      else if (!it.name.endsWith('.__meta')) {
        const st = await fs.stat(full);
        out.push({ key: dec(path.relative(base, full)), etag: `${st.mtimeMs}-${st.size}` });
      }
    }
  }
  return {
    async getJSON<T>(key: string) {
      try {
        return JSON.parse(await fs.readFile(enc(key), 'utf8')) as T;
      } catch {
        return null;
      }
    },
    async setJSON(key, value) {
      const f = enc(key);
      await fs.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, f);
    },
    async setJSONIfNew(key, value) {
      const f = enc(key);
      await fs.mkdir(path.dirname(f), { recursive: true });
      try {
        await fs.writeFile(f, JSON.stringify(value), { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    },
    async delete(key) {
      await fs.rm(enc(key), { force: true });
      await fs.rm(`${enc(key)}.__meta`, { force: true });
    },
    async list(prefix) {
      const out: { key: string; etag: string }[] = [];
      await walk(root, root, out);
      return out.filter((b) => !b.key.endsWith('.tmp') && (!prefix || b.key.startsWith(prefix))).sort((a, b) => a.key.localeCompare(b.key));
    },
    async getBytes(key) {
      try {
        const data = new Uint8Array(await fs.readFile(enc(key)));
        const meta = JSON.parse(await fs.readFile(`${enc(key)}.__meta`, 'utf8').catch(() => '{}'));
        return { data, type: meta.type || 'application/octet-stream' };
      } catch {
        return null;
      }
    },
    async setBytes(key, data, type) {
      const f = enc(key);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, data);
      await fs.writeFile(`${f}.__meta`, JSON.stringify({ type }));
    },
  };
}

let opened: Promise<Stores> | null = null;
export let storageError: string | null = null;

export function openStores(): Promise<Stores> {
  if (!opened) {
    opened = (async () => {
      const dir = process.env.LOCAL_STORE_DIR;
      if (dir) {
        return { kind: 'files', social: fileKV(path.join(dir, 'social')), catalog: fileKV(path.join(dir, 'catalog')), media: fileKV(path.join(dir, 'media')) } as Stores;
      }
      try {
        const { getStore } = await import('@netlify/blobs');
        const mk = (name: string) => blobsKV(getStore({ name, consistency: 'strong' }));
        return { kind: 'netlify-blobs', social: mk('mouneh-social'), catalog: mk('mouneh-catalog'), media: mk('mouneh-media') } as Stores;
      } catch (e) {
        storageError = `Netlify Blobs is not available: ${(e as Error).message}`;
        opened = null;
        throw new Error(storageError);
      }
    })();
  }
  return opened;
}
