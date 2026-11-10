// Recalls earlier turns for the current message. The exact calendar date wins when the user
// gave one ("on Monday", "3 November"); otherwise turns are ranked by meaning plus keywords.
// Embeddings only LOCATE old turns. What those turns said is passed to the model verbatim,
// dated, so the model compares dated text instead of trusting similarity to say what is current.

import { cosine, lexical, bm25 } from './embed.js';
import { dayKey, refMatches } from './dates.js';

const SEMANTIC_MIN = 0.62; // gemini-embedding-001 at 384 dims: related text lands around 0.65-0.85
const KEYWORD_MIN = 0.3;

/**
 * @param {{ts: string, q: string, a: string, vec?: number[], id: string}[]} pairs
 * @param {{start: string, end: string, phrase: string}[]} refs resolved date ranges in the message
 * @returns {{hits: object[], note: string, dated: boolean}}
 */
export function recall({ query, qvec = null, pairs, refs, tz, skip = new Set(), limit = 4 }) {
  const pool = pairs.filter((p) => !skip.has(p.id));
  const onDay = (p) => dayKey(p.ts, tz);
  const inRange = refs.length ? pool.filter((p) => refs.some((r) => refMatches(r, onDay(p)))) : [];
  const dated = inRange.length > 0;

  // Two rankers, one fused order. Meaning finds "that database vendor thing" when no word matches;
  // BM25 finds the exact product name when the vectors are vague. Reciprocal rank fusion combines
  // them without having to calibrate two different score scales. Recency breaks ties.
  const candidates = dated ? inRange : pool;
  const docs = candidates.map((p) => `${p.q} ${p.a}`);
  const bm = bm25(query, docs);
  const items = candidates.map((p, i) => ({
    p, lex: lexical(query, docs[i]), bm: bm[i], sem: qvec && p.vec ? cosine(qvec, p.vec) : null,
  }));
  const rankBy = (key) => {
    items.filter((x) => x[key] !== null && x[key] > 0).sort((a, b) => b[key] - a[key]).forEach((x, i) => { x[`rank_${key}`] = i; });
  };
  rankBy('sem');
  rankBy('bm');
  const newest = Math.max(...candidates.map((p) => Date.parse(p.ts)), 0);
  const fuse = (x) =>
    (x.rank_sem === undefined ? 0 : 1 / (60 + x.rank_sem)) +
    (x.rank_bm === undefined ? 0 : 1 / (60 + x.rank_bm)) +
    1e-4 * (1 - (newest - Date.parse(x.p.ts)) / (30 * 86400_000 || 1)); // newer wins a tie, over a 30-day span
  for (const x of items) x.score = fuse(x);

  // A date match is trusted. Without one, a turn must clear a relevance bar before it is recalled at all,
  // otherwise an unrelated question would drag in whatever is closest.
  let ranked = items;
  if (!dated) ranked = ranked.filter((s) => (s.sem !== null && s.sem >= SEMANTIC_MIN) || s.lex >= KEYWORD_MIN);
  ranked.sort((a, b) => b.score - a.score);

  const hits = ranked
    .slice(0, dated ? 6 : limit)
    .map((s) => s.p)
    .sort((a, b) => a.ts.localeCompare(b.ts)); // chronological reads better

  let note = '';
  if (refs.length && !dated) {
    const days = (r) => (r.start === r.end ? r.start : `${r.start} to ${r.end}`) + (r.alt ? ` or ${r.alt}` : '');
    note = `The user mentioned ${refs.map((r) => `"${r.phrase}" (${days(r)})`).join(', ')}, but no stored conversation falls on that date.`;
  }
  return { hits, note, dated };
}
