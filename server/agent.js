// The agent. One tool (web_search), one answering model, and a harness that does the rest:
//   1. resolve dates in the message (code, not model)
//   2. recall earlier turns from the history the browser sent (exact date first, then meaning)
//   3. PLAN: a small fast model decides whether to search and writes one query per item to check
//   4. SEARCH: all planned queries run in parallel (a model that searches one item per round is slow)
//   5. ANSWER: the main model streams from the results; it may still call web_search once more
//   6. number sources globally so [n] markers can be checked against results that really came back
// Memory is NOT a tool: the model keeps exactly one tool, and relevant history arrives in its prompt.

import { chat, ask } from './llm.js';
import { webSearchMany, DEPTHS, depthOf } from './search.js';
import { embed } from './embed.js';
import { recall } from './memory.js';
import { resolveDates, dayKey, prettyDay, refMatches } from './dates.js';

const MAX_SEARCHES = 8; // planned + model-requested; protects the free search quota
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FENCE = '`'.repeat(3);

const TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the live web. Returns up to 4 ranked results with title, url, publication date and text. When `after` is set, results mix pages published since that date (news, announcements; new:true) with the top current pages for the query (such as the vendor\'s own pricing page; new:false). Use `after` for "what changed since" questions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Standalone search query that names the product or topic. No pronouns.' },
        after: { type: 'string', description: 'Optional YYYY-MM-DD. Only pages published on or after this day.' },
        before: { type: 'string', description: 'Optional YYYY-MM-DD. Only pages published on or before this day.' },
      },
      required: ['query'],
    },
  },
};

const ABOUT_PAST = /\b(earlier|before|previous(ly)?|last time|ask(ed)? you|we (talked|discussed|shortlisted|looked)|you (said|told|recommended|suggested)|remind me)\b/i;
const trim = (s, n) => String(s ?? '').slice(0, n);

/** Earlier turns as dated text. Shared by the planner and the answering model. */
function historyBlock(hits, tz, charsEach) {
  return hits
    .map((p) => {
      const day = dayKey(p.ts, tz);
      const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: tz }).format(new Date(p.ts));
      return `[${day}, ${prettyDay(day).split(' ')[0]} ${time}] User asked: ${p.q}\nYou answered: ${trim(p.a, charsEach)}`;
    })
    .join('\n\n');
}

const showRef = (r) =>
  `"${r.phrase}" = ${r.start === r.end ? `${r.start} (${prettyDay(r.start)})` : `${r.start} to ${r.end}`}${r.alt ? `, or ${r.alt} if they mean the week before` : ''}`;

function systemPrompt({ now, tz, refs, hits, note, pastIntent, sinceDay, results, style }) {
  const stamp = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(now);
  const lines = [
    'You are Since, a research assistant. You answer with live web evidence and you remember what this user asked before.',
    '',
    `Now: ${stamp} (${tz}).`,
    '',
    'How to work',
    '- Lead with the answer in the first sentence. No preamble, no restating the question, no closing offer.',
    '- Use web search for anything that can change: prices, plans, releases, versions, news, availability, who holds a role. Not for stable facts, arithmetic, writing help or casual chat.',
    '- Cite with [n] directly after each claim taken from a search result, using the n in that result. Use only facts found in results. Never invent a URL, price or date. If results disagree, say so.',
    '- Prefer a vendor\'s own pages over aggregators and blogs for prices and features. Say when you rely on a weaker source.',
    '- Give dates: "as of 8 Nov" using the result date. If a result has no date, say its date is unknown. Never present an old source as current.',
    '- No evidence of a change is not "no change". If nothing newer turned up, say "no change found in sources published after <date>".',
    style === 'detailed'
      ? '- Give a fuller answer, up to about 300 words: short sections, the reasoning behind a conclusion, and the caveats worth knowing. Plain words. Ask one question only when you cannot proceed without it.'
      : '- Be concise. Short paragraphs. A list only for parallel items. Plain words. Ask one question only when you cannot proceed without it.',
  ];

  if (refs.length) lines.push('', 'Dates in the user message, resolved: ' + refs.map(showRef).join('; ') + '.');
  if (hits.length || note || pastIntent) {
    lines.push('', 'Earlier conversations with this user (their saved history, oldest first):');
    lines.push(hits.length ? historyBlock(hits, tz, 1200) : note || 'No earlier conversation matching this message was found in the saved history.');
    lines.push(
      '',
      'Rules for this history',
      '- It is the only record of earlier conversations. If the user refers to one that is not above, say you have no record of it. Do not guess.',
      '- If the user asks what they asked or said earlier, start by stating it plainly with its date, then deal with the rest of the message.',
      `- If the user asks whether an earlier answer still holds, or what changed since, compare each claim in it ("then") with what the search results say now ("now"). The earlier conversation was on ${sinceDay}.`,
      '- After a short written summary, add one fenced block for the comparison, exactly in this shape:',
      `${FENCE}changes`,
      '[{"item":"HubSpot Starter","then":"$20/seat/month","now":"$23/seat/month","status":"changed","src":2}]',
      FENCE,
      '  status is "changed", "same" or "unverified" (no evidence found). "src" is the n of the result, or null. Keep each value under 40 characters. Do not repeat the block as a table in prose.',
      '- Use "same" or "changed" only when a cited result states the current value, and copy the figure exactly as the result writes it. A result that does not mention the value is NOT evidence that it is unchanged: use "unverified". Never confirm a price you did not see in a result.',
    );
  }
  if (results) {
    lines.push(
      '',
      'Search results already gathered for this message. Use them. Call web_search only if something essential is missing, and put all the calls in one reply.',
      results,
    );
  }
  return lines.join('\n');
}

/**
 * Asks a small model for the searches this message needs. Returns null on any failure, and the
 * answering model then searches for itself through the tool. Never blocks the answer for long.
 */
async function plan({ message, now, tz, refs, hits, sinceDay, recent, signal, depth }) {
  const maxQueries = DEPTHS[depth].queries;
  const stamp = new Intl.DateTimeFormat('en-CA', { dateStyle: 'full', timeZone: tz }).format(now);
  const system = [
    'You plan web searches for a research assistant. Reply with ONLY a JSON object, no prose:',
    '{"search": boolean, "queries": [{"q": string, "after": string|null, "must": string}]}',
    '',
    'Rules:',
    '- search=false for chit-chat, writing help, arithmetic, stable facts, or anything the conversation already answers.',
    '- search=true for anything that can change (prices, plans, releases, versions, news, availability) or that needs sources.',
    '- One query per thing to check. Five products means five queries. Never put two products in one query. Max ' + maxQueries + '.',
    '- Each q is standalone and names the product or topic. No pronouns. Do NOT put dates or words like "since" or "change" in q: the date goes in "after". For a price use e.g. "HubSpot Sales Hub Starter price per seat". If the user asks about pricing OR big releases, use one query per product such as "HubSpot pricing and major new features".',
    '- "must" is ONE lowercase word that every relevant page mentions: the product or topic name, e.g. "hubspot".',
    '- "after" is a YYYY-MM-DD day, or null. Set it for news, releases and "what changed since" questions. When re-checking an earlier answer, use the date of that earlier conversation. For plain "what is it now" questions use null.',
    `Today is ${stamp}.`,
    refs.length ? 'Dates in the message: ' + refs.map(showRef).join('; ') + '.' : '',
    hits.length ? `Earlier conversation date: ${sinceDay}. Its content:\n${historyBlock(hits, tz, 700)}` : '',
    recent.length ? `Latest turns in this chat:\n${recent.slice(-2).map((p) => `User: ${trim(p.q, 300)}\nAssistant: ${trim(p.a, 300)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  try {
    const raw = await ask({
      messages: [{ role: 'system', content: system }, { role: 'user', content: message }],
      fast: true, effort: 'low', maxTokens: 700,
      signal: AbortSignal.any([AbortSignal.timeout(6000), ...(signal ? [signal] : [])]),
    });
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const queries = (Array.isArray(json.queries) ? json.queries : [])
      .map((x) => ({
        query: String(x?.q ?? x?.query ?? '').trim(),
        after: DAY.test(x?.after || '') ? x.after : undefined,
        must: typeof x?.must === 'string' ? x.must : undefined,
      }))
      .filter((x) => x.query)
      .slice(0, maxQueries);
    return { search: Boolean(json.search) && queries.length > 0, queries };
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn(`[plan] skipped: ${e.message.slice(0, 160)}`);
    return null;
  }
}

/** Numbers each distinct URL once per message, so [n] means the same source everywhere. */
function registry() {
  return { sources: [], byUrl: new Map(), texts: new Map(), searches: 0 };
}

/**
 * Parses the model's ```changes block and checks it against what the searches actually returned.
 * A row may say "same" or "changed" only if its cited source text contains the figure it claims.
 * Otherwise it is downgraded to "unverified". The model cannot confirm what it did not read.
 */
export function verifyLedger(text, texts, earlier = '') {
  // Models sometimes emit one block per row, or a single object instead of an array. Accept all.
  const rows = [];
  for (const m of text.matchAll(/```changes\s*([\s\S]*?)```/g)) {
    try {
      const json = JSON.parse(m[1]);
      rows.push(...(Array.isArray(json) ? json : [json]));
    } catch { /* skip a malformed block */ }
  }
  if (!rows.length) return null;
  return rows.filter((r) => typeof r?.item === 'string').slice(0, 12).map((r) => {
    const row = {
      item: trim(r?.item, 60), then: trim(r?.then, 60), now: trim(r?.now, 60),
      status: ['changed', 'same', 'unverified'].includes(r?.status) ? r.status : 'unverified',
      src: Number.isInteger(r?.src) ? r.src : null,
    };
    const figuresOf = (s) => (s.match(/\d[\d,.]*\d|\d/g) || []).map((f) => f.replace(/,/g, ''));
    if (row.status !== 'unverified') {
      const evidence = (texts.get(row.src) || '').replace(/,/g, '');
      const figures = figuresOf(row.now);
      const supported = evidence && (figures.length === 0 || figures.some((f) => evidence.includes(f)));
      if (!supported) Object.assign(row, { status: 'unverified', reason: 'No cited source states this value' });
    }
    // "Earlier" must be what the earlier answer said, not what the model remembers it saying.
    const before = earlier.replace(/,/g, '');
    const was = figuresOf(row.then);
    if (before && was.length && !was.some((f) => before.includes(f))) {
      Object.assign(row, { status: 'unverified', reason: 'This earlier value is not in your earlier answer' });
    }
    return row;
  });
}
/** Runs a batch of searches together (one batched ranking call underneath) and numbers the results. */
async function searchAll(list, reg, ctx) {
  const run = list.slice(0, Math.max(0, MAX_SEARCHES - reg.searches));
  reg.searches += run.length;
  const found = run.length ? await webSearchMany(run, ctx) : [];
  return list.map((_, i) => {
    if (i >= run.length) return { error: 'Search budget for this message is used up. Answer with what you have.' };
    const r = found[i];
    if (!r.results.length) return { error: `Search failed: ${r.error || 'no results'}` };
    return {
      results: r.results.map((x) => {
        let n = reg.byUrl.get(x.url);
        if (!n) {
          n = reg.sources.length + 1;
          reg.byUrl.set(x.url, n);
          reg.sources.push({ n, title: x.title, url: x.url, domain: x.domain, date: x.date });
        }
        reg.texts.set(n, `${reg.texts.get(n) || ''} ${x.title} ${x.text}`);
        return { n, title: x.title, url: x.url, domain: x.domain, date: x.date || 'unknown', new: Boolean(x.isNew), text: x.text };
      }),
    };
  });
}

function resultsBlock(queries, outputs) {
  return queries
    .map((q, i) => {
      const o = outputs[i];
      const head = `Search ${i + 1}: "${q.query}"${q.after ? ` (results marked NEW were published since ${q.after})` : ''}`;
      if (o.error) return `${head}\n  ${o.error}`;
      return `${head}\n${o.results.map((r) => `  [${r.n}] ${r.domain}: ${r.title} (${r.date}${r.new ? ', NEW' : ''})\n      ${r.text}`).join('\n')}`;
    })
    .join('\n\n');
}

/** Yields {event, data} for the SSE layer. */
export async function* runAgent({ message, tz = 'UTC', pairId, recent = [], memory = [], now = new Date(), signal, depth = 'balanced', style = 'concise' }) {
  depth = depthOf(depth);
  const started = Date.now();
  const { today, refs } = resolveDates(message, now, tz);

  // Start embedding right away; it is awaited only if recall needs it, and for the returned vectors.
  const missing = memory.filter((p) => !p.vec).slice(-30);
  // Old turns are embedded as question + the start of the answer, so recall can match what was SAID, not just what was asked.
  const docText = (p) => `${p.q}. ${String(p.a).replace(/```changes[\s\S]*?```/g, '').slice(0, 240)}`;
  const vecJob = embed([message, ...missing.map(docText)], { signal });

  const skip = new Set(recent.map((p) => p.id));
  const dateHit = refs.length > 0 && memory.some((p) => refs.some((r) => refMatches(r, dayKey(p.ts, tz))));
  let qvec = null;
  if (memory.length && !dateHit) {
    yield { event: 'status', data: { text: 'Checking your history' } };
    const v = await vecJob;
    if (v) { qvec = v[0]; missing.forEach((p, i) => { p.vec = v[i + 1]; }); }
  }
  const { hits, note } = recall({ query: message, qvec, pairs: memory, refs, tz, skip });
  const pastIntent = ABOUT_PAST.test(message) && !hits.length && !note;
  const sinceDay = hits.length ? dayKey(hits[0].ts, tz) : today;

  const reg = registry();
  const ctx = { today, signal, depth };
  const t = { plan: 0, search: 0 };

  // PLAN, then SEARCH in parallel.
  let results = '';
  let t0 = Date.now();
  const planned = await plan({ message, now, tz, refs, hits, sinceDay, recent, signal, depth });
  t.plan = Date.now() - t0;
  if (planned?.search) {
    yield { event: 'status', data: { text: `Searching: ${planned.queries.map((q) => q.query).join(' · ')}`, queries: planned.queries.map((q) => q.query) } };
    t0 = Date.now();
    const outputs = await searchAll(planned.queries, reg, ctx);
    t.search = Date.now() - t0;
    results = resultsBlock(planned.queries, outputs);
    yield { event: 'sources', data: { items: reg.sources } };
  }

  // ANSWER. The planner failing (null) means the model gets the tool and searches for itself, two rounds.
  const maxRounds = planned ? 1 : 2;
  const messages = [{ role: 'system', content: systemPrompt({ now, tz, refs, hits, note, pastIntent, sinceDay, results, style }) }];
  for (const p of recent.slice(-6)) messages.push({ role: 'user', content: trim(p.q, 1500) }, { role: 'assistant', content: trim(p.a, 1500) });
  messages.push({ role: 'user', content: message });

  let provider = null;
  let firstToken = null;
  let answer = '';
  for (let round = 0; round <= maxRounds; round++) {
    const mustAnswer = round === maxRounds;
    // On the last round keep the history and tell the model to stop; removing the tool makes some
    // models fail the whole request when they still try to call it.
    const turn = mustAnswer
      ? [...messages, { role: 'user', content: 'Write the final answer now from the search results above. Do not call any tool.' }]
      : messages;
    let calls = null;
    for await (const ev of chat({ messages: turn, tools: mustAnswer ? undefined : [TOOL], effort: 'low', signal })) {
      if (ev.type === 'provider') provider = { id: ev.id, model: ev.model };
      else if (ev.type === 'delta') {
        firstToken ??= Date.now() - started;
        answer += ev.text;
        yield { event: 'delta', data: { text: ev.text } };
      } else if (ev.type === 'tool_calls') {
        calls = ev.message.tool_calls;
        messages.push(ev.message);
      }
    }
    if (!calls) break;

    const parsed = calls.map((c) => {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* reported to the model below */ }
      return { c, args };
    });
    const queries = parsed.filter((x) => x.c.function.name === 'web_search' && x.args.query).map((x) => x.args.query);
    yield { event: 'status', data: { text: queries.length ? `Searching: ${queries.join(' · ')}` : 'Working', queries } };
    t0 = Date.now();
    const valid = parsed.filter(({ c, args }) => c.function.name === 'web_search' && args.query);
    const searched = await searchAll(valid.map(({ args }) => args), reg, ctx);
    const outputs = parsed.map(({ c, args }) => {
      if (c.function.name !== 'web_search') return { error: `Unknown tool "${c.function.name}". The only tool is web_search.` };
      if (!args.query) return { error: 'web_search needs a query.' };
      return searched[valid.findIndex((v) => v.args === args)];
    });
    t.search += Date.now() - t0;
    calls.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(outputs[i]) }));
    yield { event: 'sources', data: { items: reg.sources } };
  }

  const ledger = verifyLedger(answer, reg.texts, hits.map((p) => p.a).join(' '));
  if (ledger) yield { event: 'ledger', data: { rows: ledger } }; // the browser renders this, not the raw block

  yield {
    event: 'done',
    data: { provider, ms: Date.now() - started, firstTokenMs: firstToken, planMs: t.plan, searchMs: t.search, searches: reg.searches, sources: reg.sources.length, recalled: hits.length },
  };

  // Vectors for the browser to store, sent AFTER `done` so they never delay the answer: this turn (question +
  // start of the answer, now that it exists) and any older turns that lacked one.
  const early = await vecJob;
  const vectors = {};
  if (early) missing.forEach((p, i) => { if (early[i + 1]) vectors[p.id] = early[i + 1]; });
  if (pairId) {
    const own = await embed([docText({ q: message, a: answer })], { signal });
    if (own?.[0]) vectors[pairId] = own[0];
  }
  yield { event: 'vectors', data: { vectors } };
}
