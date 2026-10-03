// Records kept in storage. Each object has one writer, so concurrent functions never overwrite each other:
// posts and comments are written once, the post analysis, drafts and replies each have their own key.
import type { TraceItem } from './graphs/runtime';
import type { BasisItem, Lang, ReplyKind } from './reply';
import type { Intent } from './understand';

export interface Persona {
  id: string;
  name: string; // display name
  handle: string;
  color: string;
}

export interface PostRec {
  id: string;
  created_at: string;
  caption: string;
  image: string; // a path on the team site: /seed/... or /api/media/...
  seed?: boolean;
}

export interface PostProduct {
  id: string; // catalog entry id, e.g. product:tahini
  name: string;
  name_ar: string;
  pack: string | null;
  source: 'ai' | 'rules' | 'team' | 'seed';
  conf: number;
}

export interface PostCtx {
  post_id: string;
  status: 'pending' | 'done' | 'failed';
  products: PostProduct[];
  summary: string;
  by: 'ai' | 'rules' | 'team' | 'seed';
  engine?: string;
  analyzed_at: string;
  trace?: TraceItem[];
  notes?: string[];
  error?: string;
  via?: 'background' | 'page';
}

export interface CommentRec {
  id: string;
  post_id: string;
  created_at: string;
  persona_id: string;
  author_name: string;
  author_handle: string;
  text: string;
  seed?: boolean;
}

export type DraftStatus = 'drafting' | 'ready' | 'needs_choice' | 'needs_human' | 'no_reply' | 'failed';

export interface DraftOption {
  id: string;
  label: string;
  label_ar: string;
}

export interface DraftRec {
  comment_id: string;
  post_id: string;
  status: DraftStatus;
  kind: ReplyKind;
  text: string;
  lang: Lang;
  intent: Intent | null;
  understood_by: 'ai' | 'rules' | null;
  written_by: 'ai' | 'template' | null;
  engine: 'langgraph' | 'built-in' | null;
  model: string | null;
  products: { id: string; name: string; name_ar: string }[];
  place: { type: string; key: string; name: string; name_ar: string } | null;
  scope_note: string | null;
  pack: string | null;
  basis: BasisItem[];
  options: { slot: 'product' | 'place'; items: DraftOption[] } | null;
  checks: string[];
  notes: string[];
  trace: TraceItem[];
  reason: string;
  created_at: string;
  started_at?: string;
  ms: number;
  error?: string;
  choice?: { slot: 'product' | 'place'; id: string } | null;
  via?: 'background' | 'page'; // "page": no background job started, so the team page drafts it right away
}

// A background job writes beats/<job id> every 20 seconds while it works, so the team page leaves its drafts alone.
export interface BeatRec {
  at: string;
  running: string[]; // comment ids being drafted now
  queued: string[]; // comment ids waiting their turn, in order
  wait: { until: string; why: string } | null; // waiting out the AI model's rate limit
}

// What the team page gets for a comment a job is holding.
export interface CommentBeat {
  at: string;
  state: 'running' | 'queued';
  pos: number; // place in the queue (0 while running)
  of: number; // queue length
  wait: BeatRec['wait'];
}

export interface ReplyRec {
  comment_id: string;
  post_id: string;
  text: string;
  at: string;
  by: string; // "team" or "seed"
  edited: boolean;
  dismissed?: boolean;
}
