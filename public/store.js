// Memory lives here, in the browser. The server keeps nothing, so the app works the same on a
// laptop and on a host that wipes its disk. Shape:
//   thread = { id, title, created, updated, sample?, pairs: [pair] }
//   pair   = { id, ts (ISO), q, a, vec?: number[384], sources?: [], ledger?: [], meta? }

const KEY = 'since.v1';
const uid = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
export { uid };

let state = read();

function read() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(s?.threads)) return s;
  } catch { /* private mode or corrupt data: start empty */ }
  return { threads: [] };
}

function write() {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); return; } catch { dropOldest(); }
  }
}

/** Storage is full: forget the oldest question rather than lose the new one. */
function dropOldest() {
  const oldest = state.threads.flatMap((t) => t.pairs.map((p) => ({ t, p }))).sort((a, b) => a.p.ts.localeCompare(b.p.ts))[0];
  if (!oldest) return;
  oldest.t.pairs = oldest.t.pairs.filter((p) => p !== oldest.p);
  state.threads = state.threads.filter((t) => t.pairs.length || t !== oldest.t);
}

export const threads = () => state.threads.filter((t) => t.pairs.length).sort((a, b) => b.updated.localeCompare(a.updated));
export const get = (id) => state.threads.find((t) => t.id === id);
export const countPairs = () => state.threads.reduce((n, t) => n + t.pairs.length, 0);

export function newThread() {
  const now = new Date().toISOString();
  const t = { id: uid(), title: '', created: now, updated: now, pairs: [] };
  state.threads.push(t);
  return t;
}

export function addPair(threadId, pair) {
  const t = get(threadId);
  if (!t) return;
  t.pairs.push(pair);
  t.title ||= pair.q.length > 64 ? `${pair.q.slice(0, 63).trimEnd()}…` : pair.q;
  t.updated = pair.ts;
  write();
}

export function applyVectors(map) {
  const byId = new Map(state.threads.flatMap((t) => t.pairs).map((p) => [p.id, p]));
  for (const [id, vec] of Object.entries(map || {})) if (byId.has(id)) byId.get(id).vec = vec;
  write();
}

export function remove(id) {
  state.threads = state.threads.filter((t) => t.id !== id);
  write();
}

export function clear() {
  state = { threads: [] };
  write();
}

export function importThreads(list) {
  state.threads.push(...list);
  write();
}

/** What the server needs: the live conversation, plus saved history it may recall from. */
export function payload(threadId) {
  const t = get(threadId);
  const pairs = state.threads.flatMap((x) => x.pairs).sort((a, b) => a.ts.localeCompare(b.ts)).slice(-150);
  return {
    recent: (t?.pairs ?? []).slice(-6).map((p) => ({ id: p.id, q: p.q, a: p.a.slice(0, 1500) })),
    memory: pairs.map((p) => ({ id: p.id, ts: p.ts, q: p.q, a: p.a.slice(0, 1200), vec: p.vec })),
  };
}
