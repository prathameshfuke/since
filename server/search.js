// The agent's one tool. Two providers with different strengths, so each search asks the right one:
//   Tavily     answers "what is true now": official pages rank well and it takes bursts of parallel calls.
//   LangSearch answers "what was published since": exact date ranges and a publication date per result,
//              but it rate-limits hard (about 5 of 10 parallel calls got HTTP 429), so calls are paced.
// Each is the other's fallback. Results are reranked by meaning, and weak matches are dropped.

import { embed, cosine } from './embed.js';

const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // "query|after|before" -> { at, value }; saves quota on repeats
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SNIPPET_CHARS = 400; // small on purpose: Groq's free tier is 8,000 tokens a minute
const MIN_SIMILARITY = 0.45; // below this a result is about something else
const PER_GROUP = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const domainOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};
const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
const withSignal = (signal) => AbortSignal.any([AbortSignal.timeout(9000), ...(signal ? [signal] : [])]);
const httpError = (res) => Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });

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

async function langsearch({ query, after, before, today, signal }) {
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
      title: i.name, url: i.url, date: (i.datePublished || '').slice(0, 10) || null, text: clip(i.summary || i.snippet),
    }));
  });
}

async function tavily({ query, after, before, today, signal }) {
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
    title: i.title, url: i.url, date: (i.published_date || '').slice(0, 10) || null, text: clip(i.content),
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

/**
 * Keeps results that match the query, best first. A result whose domain contains a word of the query
 * ("hubspot" in "HubSpot pricing") gets a boost: for prices and features the vendor's own page is the
 * best evidence and keyword-stuffed aggregators otherwise outrank it.
 */
async function rank(query, items, signal) {
  const vecs = await embed([query, ...items.map((r) => `${r.title}. ${r.text}`)], { signal });
  const q = query.toLowerCase();
  const official = (r) => (domainOf(r.url).split('.').slice(-2, -1)[0] || '').length > 3 && q.includes(domainOf(r.url).split('.').slice(-2, -1)[0]);
  const scored = items.map((r, i) => {
    const sim = vecs?.[0] && vecs[i + 1] ? cosine(vecs[0], vecs[i + 1]) : null;
    return { r, sim, score: (sim ?? 0.6) + (official(r) ? 0.15 : 0) };
  });
  if (process.env.DEBUG_SEARCH) scored.forEach((s) => console.warn(`[rank] ${s.sim?.toFixed(2)} ${domainOf(s.r.url)} ${s.r.title.slice(0, 50)}`));
  return scored
    .filter((s) => s.sim === null || s.sim >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.r);
}

/**
 * @param {{query: string, after?: string, before?: string}} args
 * @returns {{ results: {title, url, domain, date, text, isNew}[], error?: string }}
 * With `after`, results come from two searches: what was published since (isNew) and what is current.
 */
export async function webSearch({ query, after, before, must }, { today, signal } = {}) {
  query = String(query || '').trim().slice(0, 300);
  if (!query) return { results: [], error: 'empty query' };
  const needle = String(must || '').toLowerCase().trim().slice(0, 40);

  const key = `${query.toLowerCase()}|${after || ''}|${before || ''}|${needle}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const windowed = DAY.test(after || '');
  const errors = [];
  const base = { query, today, signal };
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
    // `must` is a word every relevant page mentions (the product name). It removes pages that only
    // matched generic words like "price" or "new features".
    .filter((r) => !needle || `${r.title} ${r.text} ${r.url}`.toLowerCase().includes(needle));
  if (!merged.length) return { results: [], error: errors.join('; ') || (needle ? `no results mention "${needle}"` : 'no results') };

  const ranked = await rank(query, merged, signal);
  const results = (windowed
    ? [...ranked.filter((r) => r.isNew).slice(0, PER_GROUP), ...ranked.filter((r) => !r.isNew).slice(0, PER_GROUP)]
    : ranked.slice(0, 4)
  ).map((r) => ({ ...r, domain: domainOf(r.url) }));

  const value = results.length ? { results } : { results, error: 'results found but none matched the query' };
  if (results.length) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return value;
}
