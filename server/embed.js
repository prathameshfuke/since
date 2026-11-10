// Semantic helpers. Embeddings come from Gemini (free tier) at 384 dimensions, so a stored
// turn costs about 3 KB. Everything degrades to keyword overlap when embeddings are unavailable.

const URL = 'https://generativelanguage.googleapis.com/v1beta/openai/embeddings';
export const DIMS = 384;
const cache = new Map(); // text -> vector, so repeated queries and snippets cost nothing

const normalise = (v) => {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => Math.round((x / len) * 1e4) / 1e4);
};

/** Dot product of two unit vectors. Returns 0 if the sizes differ. */
export const cosine = (a, b) => {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** One vector per text, or null if embeddings are unavailable (callers fall back to keywords). */
export async function embed(texts, { signal } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !texts.length) return null;
  const clipped = texts.map((t) => String(t).slice(0, 1500));
  const missing = [...new Set(clipped.filter((t) => !cache.has(t)))];
  try {
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const res = await fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'gemini-embedding-001', input: batch, dimensions: DIMS }),
        signal: AbortSignal.any([AbortSignal.timeout(6000), ...(signal ? [signal] : [])]),
      });
      if (!res.ok) { console.warn(`[embed] HTTP ${res.status}`); return null; }
      const { data } = await res.json();
      batch.forEach((t, j) => cache.set(t, normalise(data[j].embedding)));
    }
  } catch (e) {
    if (!signal?.aborted) console.warn(`[embed] ${e.message}`);
    return null;
  }
  while (cache.size > 2000) cache.delete(cache.keys().next().value);
  return clipped.map((t) => cache.get(t) ?? null);
}

const STOP = new Set(
  'the and for with that this these those what which who how when why did does you your are was were been has have had can could would should about from since any all not but its than then there here just more most some such into over also only very our their they them will shall may might one two'.split(' '),
);
const words = (s) => new Set((s.toLowerCase().match(/[a-z0-9$]{3,}/g) || []).filter((w) => !STOP.has(w)));

/** Keyword overlap in 0..1 (cosine over word sets). */
export function lexical(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.sqrt(A.size * B.size);
}
