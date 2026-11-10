import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, capPerDomain, freshness } from '../server/search.js';
import { bm25, terms } from '../server/embed.js';
import { recall } from '../server/memory.js';

test('extract keeps the sentence with the price, not the cookie banner', () => {
  const page = [
    'We use cookies to improve your experience on this site.',
    'Our team has grown a lot over the years and we love what we do.',
    'Sales Hub Starter costs $20 per seat per month billed annually.',
    'Contact us for enterprise terms and a custom quote tailored to you.',
    'Read our privacy policy to learn how we handle your data in detail.',
  ].join(' ');
  const out = extract(page, 'HubSpot Sales Hub Starter price per seat', 120);
  assert.match(out, /\$20 per seat/);
  assert.doesNotMatch(out, /cookies/);
  assert.ok(out.length <= 180);
});

test('extract returns short text untouched', () => {
  assert.equal(extract('  Short   text. ', 'anything', 400), 'Short text.');
});

test('one result per domain, two for the vendor the query is about', () => {
  const list = [
    { url: 'https://hubspot.com/pricing' }, { url: 'https://hubspot.com/pricing/sales' }, { url: 'https://www.hubspot.com/x' },
    { url: 'https://aggregator.io/a' }, { url: 'https://aggregator.io/b' },
  ];
  const kept = capPerDomain(list, 'HubSpot Sales Hub price').map((r) => r.url);
  assert.deepEqual(kept, ['https://hubspot.com/pricing', 'https://hubspot.com/pricing/sales', 'https://aggregator.io/a']);
});

test('stemming makes pricing, prices and price the same term', () => {
  assert.deepEqual(new Set(terms('pricing prices priced price')), new Set(['pric']));
  assert.deepEqual(terms('Hosting hosts'), ['host', 'host']);
});

test('BM25 rewards the rare word over the common one', () => {
  const docs = ['neon postgres hosting plan', 'supabase postgres hosting plan', 'railway postgres hosting plan'];
  const [neon, supabase] = bm25('neon hosting', docs);
  assert.ok(neon > supabase, 'the doc with the rare word "neon" must win');
  assert.equal(bm25('zebra', docs).every((s) => s === 0), true);
});

test('recall fuses meaning and keywords, and still returns nothing for unrelated questions', () => {
  const TZ = 'UTC';
  const turn = (id, ts, q, a, vec) => ({ id, ts, q, a, vec });
  const pairs = [
    turn('a', '2026-11-01T10:00:00Z', 'Compare Neon and Supabase hosting', 'Neon free 0.5 GB.', [1, 0, 0]),
    turn('b', '2026-11-02T10:00:00Z', 'Name ideas for a bakery', 'Crumb and Co.', [0, 1, 0]),
    turn('c', '2026-11-03T10:00:00Z', 'Which database vendors host Postgres?', 'Several do.', [0.96, 0.2, 0]),
  ];
  const near = recall({ query: 'that database hosting question', qvec: [1, 0.05, 0], pairs, refs: [], tz: TZ }).hits.map((p) => p.id);
  assert.ok(near.includes('a') && near.includes('c') && !near.includes('b'), `got ${near}`);
  assert.deepEqual(recall({ query: 'who won the world cup', qvec: [0, 0, 1], pairs, refs: [], tz: TZ }).hits, []);
});

test('freshness is unchanged by the refactor', () => {
  assert.equal(freshness('2026-11-03', undefined, '2026-11-10'), '2026-11-03..2026-11-10');
});

test('a decimal point does not split a sentence or lose the text before it', async () => {
  const { extract } = await import('../server/search.js');
  const out = extract('NVDA trades at 188.63 USD, up 1.2% today. Unrelated filler about cooking.', 'NVDA price today', 300);
  assert.match(out, /188\.63 USD/);
});
