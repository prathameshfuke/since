// The agent's one tool. Two providers with different strengths, so each search asks the right one:
//   Tavily     answers "what is true now": official pages rank well and it takes bursts of parallel calls.
//   LangSearch answers "what was published since": exact date ranges and a publication date per result,
//              but it rate-limits hard (about 5 of 10 parallel calls got HTTP 429), so calls are paced.
// Each is the other's fallback.
//
// What happens to results before the model sees them (all of it exists to put the right evidence in a
// small token budget):
//   1. dedupe by URL, drop pages that never mention the product (`must`)
//   2. cut each page down to its most relevant SENTENCES, preferring ones with figures, not its first lines
//   3. rank by meaning against the query, with ONE batched embedding call for the whole message
//   4. cap results per domain so one aggregator cannot fill the answer; keep two from the vendor's own site

import { embed, cosine, terms, lexical } from './embed.js';

const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // "query|after|before|must|depth" -> { at, value }; saves quota on repeats
const inflight = new Map(); // identical searches running at the same moment share one request
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MIN_SIMILARITY = 0.45; // below this a result is about something else

// Depth is a user setting. Groq's free tier is 8,000 tokens a minute, so "thorough" is bounded, not unlimited.
export const DEPTHS = {
  fast: { snippet: 300, perGroup: 1, plain: 3, rerank: false, queries: 3 },
  balanced: { snippet: 400, perGroup: 2, plain: 4, rerank: true, queries: 6 },
  thorough: { snippet: 550, perGroup: 3, plain: 5, rerank: true, queries: 6 },
};
export const depthOf = (d) => (DEPTHS[d] ? d : 'balanced');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const domainOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};
const brandOf = (url) => domainOf(url).split('.').slice(-2, -1)[0] || '';
const withSignal = (signal) => AbortSignal.any([AbortSignal.timeout(9000), ...(signal ? [signal] : [])]);
const httpError = (res) => Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });

const FIGURE = /[$€£₹]\s?\d|\d[\d,.]*\s?(?:%|usd|gb|mb|tb|\/\s?(?:mo|month|seat|user|yr|year))|\b\d[\d,]{2,}\b/i;

/**
 * The most relevant sentences of a page, in their original order, within `budget` characters.
 * A price on line 9 of a pricing page beats a cookie notice on line 1.
 */
export function extract(text, query, budget = 400) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= budget) return clean;
  const wanted = new Set(terms(query));
  const sentences = clean.match(/(?:[^.!?]|[.!?](?=\S))+(?:[.!?]+(?:\s|$)|$)/g) || [clean];
  const scored = sentences.map((s, i) => ({
    s: s.trim(), i,
    score: terms(s).filter((w) => wanted.has(w)).length + (FIGURE.test(s) ? 0.8 : 0) + (i === 0 ? 0.05 : 0),
  }));
  const picked = [];
  let used = 0;
  for (const x of [...scored].sort((a, b) => b.score - a.score)) {
    if (x.score < 0.5 && picked.length) break; // never pad with sentences that match nothing
    if (used + x.s.length + 1 > budget && picked.length) continue;
    picked.push(x);
    used += x.s.length + 1;
    if (used >= budget) break;
  }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(' ').slice(0, budget + 60);
}

/** At most one result per domain, two for the site the query is about ("hubspot" in the query, hubspot.com). */
export function capPerDomain(list, query) {
  const q = String(query).toLowerCase();
  const seen = new Map();
  return list.filter((r) => {
    const d = domainOf(r.url);
    const limit = brandOf(r.url).length > 3 && q.includes(brandOf(r.url)) ? 2 : 1;
    seen.set(d, (seen.get(d) || 0) + 1);
    return seen.get(d) <= limit;
  });
}

/** LangSearch `freshness`: an exact range when `after` is a valid day, else no limit. */
export function freshness(after, before, today) {
  if (!DAY.test(after || '')) return 'noLimit';
  const end = DAY.test(before || '') && before <= today ? before : today;
  const start = after > end ? end : after;
  return `${start}..${end}`;
}

// LangSearch pacing: one request start every GAP ms, one retry after a 429.
const GAP_MS = 400;
let nextSlot = 0;
const paced = async (fn) => {
  const wait = () => { const at = Math.max(Date.now(), nextSlot); nextSlot = at + GAP_MS; return sleep(at - Date.now()); };
  await wait();
  try { return await fn(); } catch (e) {
    if (e.status !== 429) throw e;
    await sleep(900);
    await wait();
    return fn();
  }
};

async function langsearch({ query, after, before, today, signal, snippet }) {
  if (!process.env.LANGSEARCH_API_KEY) throw new Error('no LANGSEARCH_API_KEY');
  return paced(async () => {
    const res = await fetch('https://api.langsearch.com/v1/web-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LANGSEARCH_API_KEY}` },
      body: JSON.stringify({ query, freshness: freshness(after, before, today), summary: true, count: 8 }),
      signal: withSignal(signal),
    });
    if (!res.ok) throw httpError(res);
    return ((await res.json())?.data?.webPages?.value ?? []).map((i) => ({
      title: i.name, url: i.url, date: (i.datePublished || '').slice(0, 10) || null, text: extract(i.summary || i.snippet, query, snippet),
    }));
  });
}

async function tavily({ query, after, before, today, signal, snippet }) {
  if (!process.env.TAVILY_API_KEY) throw new Error('no TAVILY_API_KEY');
  const body = { query, max_results: 8, search_depth: 'basic' };
  if (DAY.test(after || '')) { body.start_date = after; body.end_date = DAY.test(before || '') ? before : today; }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify(body),
    signal: withSignal(signal),
  });
  if (!res.ok) throw httpError(res);
  return ((await res.json()).results ?? []).map((i) => ({
    title: i.title, url: i.url, date: (i.published_date || '').slice(0, 10) || null, text: extract(i.content, query, snippet),
  }));
}

/** First provider in `order` that returns results. Errors are collected, not thrown, so the other can answer. */
async function firstAnswer(order, args, errors) {
  for (const provider of order) {
    try {
      const items = await provider(args);
      if (items.length) return items;
      errors.push(`${provider.name}: no results`);
    } catch (e) {
      if (args.signal?.aborted) throw e;
      errors.push(`${provider.name}: ${e.message}`);
    }
  }
  return [];
}

/** Step 1: fetch from the providers and merge. No ranking yet, so ranking can be batched across queries. */
async function gather({ query, after, before, needle }, { today, signal, snippet }) {
  const windowed = DAY.test(after || '');
  const errors = [];
  const base = { query, today, signal, snippet };
  const [current, since] = await Promise.all([
    firstAnswer([tavily, langsearch], base, errors),
    windowed ? firstAnswer([langsearch, tavily], { ...base, after, before }, errors) : [],
  ]);
  const seen = new Set();
  const merged = [
    ...since.map((r) => ({ ...r, isNew: true })),
    ...current.map((r) => ({ ...r, isNew: Boolean(windowed && r.date && r.date >= after) })),
  ]
    .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url))
    // `needle` is a word every relevant page mentions (the product name): it removes pages that only matched generic words.
    .filter((r) => !needle || `${r.title} ${r.text} ${r.url}`.toLowerCase().includes(needle));
  return { merged, windowed, errors, after, needle };
}

/** Step 3: rank one query's candidates and choose what the model will read. */
function choose(query, g, vecs, cfg) {
  const q = query.toLowerCase();
  const official = (r) => brandOf(r.url).length > 3 && q.includes(brandOf(r.url));
  const scored = g.merged.map((r, i) => {
    const sim = vecs?.[0] && vecs[i + 1] ? cosine(vecs[0], vecs[i + 1]) : null;
    const relevance = sim ?? 0.4 + lexical(query, `${r.title} ${r.text}`); // no embeddings: fall back to keywords
    return { r, sim, score: relevance + (official(r) ? 0.15 : 0) };
  });
  if (process.env.DEBUG_SEARCH) scored.forEach((s) => console.warn(`[rank] ${s.sim?.toFixed(2)} ${domainOf(s.r.url)} ${s.r.title.slice(0, 50)}`));
  const ranked = capPerDomain(
    scored.filter((s) => s.sim === null || s.sim >= MIN_SIMILARITY).sort((a, b) => b.score - a.score).map((s) => s.r),
    query,
  );
  const picked = g.windowed
    ? [...ranked.filter((r) => r.isNew).slice(0, cfg.perGroup), ...ranked.filter((r) => !r.isNew).slice(0, cfg.perGroup)]
    : ranked.slice(0, cfg.plain);
  return picked.map((r) => ({ ...r, domain: domainOf(r.url) }));
}

/**
 * Runs several searches at once. Fetching is parallel and the ranking embeddings are ONE batched call for
 * all queries together, instead of one call per query (six calls for a five-product check was both slow
 * and enough to trip the embedding rate limit).
 * @param {{query: string, after?: string, before?: string, must?: string}[]} requests
 * @returns {Promise<{ results: {title, url, domain, date, text, isNew}[], error?: string }[]>}
 */
export async function webSearchMany(requests, { today, signal, depth = 'balanced' } = {}) {
  const level = depthOf(depth);
  const cfg = DEPTHS[level];
  const prepared = requests.map((r) => {
    const query = String(r.query || '').trim().slice(0, 300);
    const needle = String(r.must || '').toLowerCase().trim().slice(0, 40);
    return { query, after: r.after, before: r.before, needle, wide: Boolean(r.wide), key: `${query.toLowerCase()}|${r.after || ''}|${r.before || ''}|${needle}|${level}${r.wide ? '|wide' : ''}` };
  });

  const gathered = await Promise.all(prepared.map(async (p) => {
    if (!p.query) return { ...p, done: { results: [], error: 'empty query' } };
    const hit = cache.get(p.key);
    if (hit && Date.now() - hit.at < TTL_MS) return { ...p, done: hit.value };
    if (!inflight.has(p.key)) {
      inflight.set(p.key, gather(p, { today, signal, snippet: p.wide ? Math.max(cfg.snippet, 1000) : cfg.snippet }).finally(() => inflight.delete(p.key)));
    }
    return { ...p, g: await inflight.get(p.key) };
  }));

  // One embedding call for every query that has candidates.
  const ranking = gathered.filter((x) => x.g?.merged.length);
  let vecs = null;
  if (cfg.rerank && ranking.length) {
    vecs = await embed(ranking.flatMap((x) => [x.query, ...x.g.merged.map((m) => `${m.title}. ${m.text}`)]), { signal });
  }
  const slice = new Map();
  let at = 0;
  for (const x of ranking) {
    const n = x.g.merged.length + 1;
    slice.set(x, vecs ? vecs.slice(at, at + n) : null);
    at += n;
  }

  return gathered.map((x) => {
    if (x.done) return x.done;
    if (!x.g.merged.length) return { results: [], error: x.g.errors.join('; ') || (x.needle ? `no results mention "${x.needle}"` : 'no results') };
    const results = choose(x.query, x.g, slice.get(x), cfg);
    const value = results.length ? { results } : { results, error: 'results found but none matched the query' };
    if (results.length) {
      cache.set(x.key, { at: Date.now(), value });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    return value;
  });
}

/** One search. The tool-call path uses this; planned searches use webSearchMany. */
export async function webSearch(args, ctx) {
  return (await webSearchMany([args], ctx))[0];
}
