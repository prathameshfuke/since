// Recalls earlier turns for the current message. The exact calendar date wins when the user
// gave one ("on Monday", "3 November"); otherwise turns are ranked by meaning plus keywords.
// Embeddings only LOCATE old turns. What those turns said is passed to the model verbatim,
// dated, so the model compares dated text instead of trusting similarity to say what is current.

import { cosine, lexical } from './embed.js';
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

  const score = (p) => {
    const lex = lexical(query, `${p.q} ${p.a}`);
    const sem = qvec && p.vec ? cosine(qvec, p.vec) : null;
    return { p, sem, lex, score: sem === null ? lex : Math.max(sem * 0.7 + lex * 0.3, lex) };
  };

  let ranked = (dated ? inRange : pool).map(score);
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
