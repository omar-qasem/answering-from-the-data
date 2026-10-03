// Builds a graph definition with LangGraph (@langchain/langgraph). If LangGraph cannot be loaded at run time,
// the same definition runs on a small built-in runner, and the health page says which engine is live.

export type ChannelKind = 'last' | 'append';
export type NodeFn<S> = (s: S) => Promise<Partial<S> & { note?: string }>;

export interface TraceItem {
  node: string;
  ms: number;
  note?: string;
}

export interface GraphDef<S> {
  name: string;
  channels: Record<string, ChannelKind>; // every key of S, plus "trace" (append)
  nodes: Record<string, NodeFn<S>>;
  start: string;
  edges: [string, string][]; // target may be "END"
  branches: { from: string; route: (s: S) => string; map: Record<string, string> }[];
}

export interface CompiledGraph<S> {
  engine: 'langgraph' | 'built-in';
  invoke(input: Partial<S>): Promise<S>;
}

let lg: Promise<{ mod: any | null; error: string | null }> | null = null;

export function loadLangGraph(): Promise<{ mod: any | null; error: string | null }> {
  if (process.env.GRAPH_ENGINE === 'built-in') return Promise.resolve({ mod: null, error: 'GRAPH_ENGINE=built-in is set' });
  if (!lg) {
    lg = import('@langchain/langgraph')
      .then((mod: any) => (mod?.StateGraph && mod?.Annotation ? { mod, error: null } : { mod: null, error: 'LangGraph loaded without StateGraph/Annotation' }))
      .catch((e: unknown) => ({ mod: null, error: `LangGraph could not be loaded: ${(e as Error)?.message || e}` }));
  }
  return lg;
}

let lastCompileError: string | null = null;
export const graphEngineError = () => lastCompileError;

function wrap<S>(name: string, fn: NodeFn<S>) {
  return async (s: S) => {
    const t0 = Date.now();
    const out = (await fn(s)) || {};
    const { note, ...rest } = out as Partial<S> & { note?: string };
    for (const k of Object.keys(rest)) if ((rest as Record<string, unknown>)[k] === undefined) delete (rest as Record<string, unknown>)[k]; // undefined = no update, in both engines
    return { ...rest, trace: [{ node: name, ms: Date.now() - t0, ...(note ? { note } : {}) }] } as unknown as Partial<S>;
  };
}

function validate<S>(def: GraphDef<S>) {
  const names = Object.keys(def.nodes);
  for (const n of names) if (n in def.channels) throw new Error(`Node "${n}" has the same name as a state key`);
  const ok = (t: string) => t === 'END' || names.includes(t);
  if (!names.includes(def.start)) throw new Error(`Unknown start node ${def.start}`);
  for (const [a, b] of def.edges) if (!names.includes(a) || !ok(b)) throw new Error(`Bad edge ${a} -> ${b}`);
  for (const br of def.branches) {
    if (!names.includes(br.from)) throw new Error(`Bad branch source ${br.from}`);
    for (const t of Object.values(br.map)) if (!ok(t)) throw new Error(`Bad branch target ${t}`);
  }
}

function compileWithLangGraph<S>(mod: any, def: GraphDef<S>): CompiledGraph<S> {
  const { StateGraph, Annotation, START, END } = mod;
  const spec: Record<string, unknown> = {};
  for (const [k, kind] of Object.entries(def.channels)) {
    spec[k] = kind === 'append' ? Annotation({ reducer: (a: unknown[], b: unknown[]) => (a || []).concat(b || []), default: () => [] }) : Annotation();
  }
  const State = Annotation.Root(spec);
  const g: any = new StateGraph(State);
  for (const [name, fn] of Object.entries(def.nodes)) g.addNode(name, wrap(name, fn));
  g.addEdge(START, def.start);
  for (const [a, b] of def.edges) g.addEdge(a, b === 'END' ? END : b);
  for (const br of def.branches) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(br.map)) map[k] = v === 'END' ? END : v;
    g.addConditionalEdges(br.from, (s: S) => br.route(s), map);
  }
  const app = g.compile();
  return {
    engine: 'langgraph',
    invoke: async (input) => (await app.invoke(input, { recursionLimit: 40 })) as S,
  };
}

function compileBuiltIn<S>(def: GraphDef<S>): CompiledGraph<S> {
  const nodes: Record<string, (s: S) => Promise<Partial<S>>> = {};
  for (const [name, fn] of Object.entries(def.nodes)) nodes[name] = wrap(name, fn);
  return {
    engine: 'built-in',
    async invoke(input) {
      const state: Record<string, unknown> = {};
      for (const [k, kind] of Object.entries(def.channels)) if (kind === 'append') state[k] = [];
      Object.assign(state, input);
      let current = def.start;
      for (let step = 0; step < 40; step++) {
        const update = (await nodes[current](state as S)) as Record<string, unknown>;
        for (const [k, v] of Object.entries(update)) {
          if (!(k in def.channels)) continue;
          state[k] = def.channels[k] === 'append' ? [...((state[k] as unknown[]) || []), ...((v as unknown[]) || [])] : v;
        }
        const br = def.branches.find((b) => b.from === current);
        const next = br ? br.map[br.route(state as S)] : def.edges.find(([a]) => a === current)?.[1];
        if (!next) throw new Error(`No way out of node ${current}`);
        if (next === 'END') return state as S;
        current = next;
      }
      throw new Error('The graph ran more than 40 steps');
    },
  };
}

export async function compileGraph<S>(def: GraphDef<S>): Promise<CompiledGraph<S>> {
  validate(def);
  const { mod, error } = await loadLangGraph();
  if (mod) {
    try {
      const c = compileWithLangGraph(mod, def);
      lastCompileError = null;
      return c;
    } catch (e) {
      lastCompileError = `LangGraph compile failed: ${(e as Error).message}`;
    }
  } else lastCompileError = error;
  return compileBuiltIn(def);
}

// Mermaid source for the "How it works" view, generated from the same definition the engine runs.
export function toMermaid<S>(def: GraphDef<S>): string {
  const lines = ['flowchart TD', `  START([start]) --> ${def.start}`];
  for (const [a, b] of def.edges) lines.push(`  ${a} --> ${b === 'END' ? 'END([end])' : b}`);
  for (const br of def.branches) for (const [k, v] of Object.entries(br.map)) lines.push(`  ${br.from} -- ${k} --> ${v === 'END' ? 'END([end])' : v}`);
  return lines.join('\n');
}
