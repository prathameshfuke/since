import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyLedger, verifyChart } from '../server/agent.js';
import { freshness } from '../server/search.js';
import { render, cited, splitChanges, normalizeCites } from '../public/md.js';

const FENCE = '`'.repeat(3);
const block = (rows) => `Summary.\n${FENCE}changes\n${JSON.stringify(rows)}\n${FENCE}`;
const texts = new Map([[2, 'HubSpot Sales Hub Starter $20 per seat per month'], [3, 'Pricing page with no figures']]);

test('a row stays "same" only if the cited source contains the figure', () => {
  const [ok, bad] = verifyLedger(block([
    { item: 'HubSpot', then: '$20', now: '$20/seat', status: 'same', src: 2 },
    { item: 'Pipedrive', then: '$14', now: '$39/seat', status: 'changed', src: 3 },
  ]), texts);
  assert.equal(ok.status, 'same');
  assert.equal(bad.status, 'unverified');
  assert.match(bad.reason, /No cited source/);
});

test('an "earlier" value the earlier answer never gave is not accepted', () => {
  const earlier = 'Neon free plan with 0.5 GB of storage. Supabase Pro $25 a month.';
  const [fine, invented] = verifyLedger(block([
    { item: 'Supabase Pro', then: '$25/mo', now: '$25/mo', status: 'same', src: 2 },
    { item: 'Neon storage', then: '1 GB', now: '$20', status: 'changed', src: 2 },
  ]), new Map([[2, 'Supabase Pro is $25 per month. Neon Launch is $20 per month.']]), earlier);
  assert.equal(fine.status, 'same');
  assert.equal(invented.status, 'unverified');
  assert.match(invented.reason, /not in your earlier answer/);
});

test('a confirmed row with no source is downgraded', () => {
  const [row] = verifyLedger(block([{ item: 'Zoho', then: '$14', now: '$14', status: 'same', src: null }]), texts);
  assert.equal(row.status, 'unverified');
});

test('an invented status falls back to unverified, and several blocks are merged', () => {
  const text = `${block([{ item: 'A', then: '1', now: 'x', status: 'great', src: null }])}\n${block({ item: 'B', then: '2', now: 'y', status: 'unverified', src: null })}`;
  const rows = verifyLedger(text, texts);
  assert.deepEqual(rows.map((r) => [r.item, r.status]), [['A', 'unverified'], ['B', 'unverified']]);
});

test('no block, or broken JSON, gives no ledger', () => {
  assert.equal(verifyLedger('Just prose.', texts), null);
  assert.equal(verifyLedger(`${FENCE}changes\n{not json\n${FENCE}`, texts), null);
});

test('date window: exact range, clamped to today, otherwise unlimited', () => {
  assert.equal(freshness('2026-11-03', undefined, '2026-11-10'), '2026-11-03..2026-11-10');
  assert.equal(freshness('2026-11-03', '2026-12-31', '2026-11-10'), '2026-11-03..2026-11-10');
  assert.equal(freshness('2026-12-01', undefined, '2026-11-10'), '2026-11-10..2026-11-10');
  assert.equal(freshness('last week', undefined, '2026-11-10'), 'noLimit');
  assert.equal(freshness(undefined, undefined, '2026-11-10'), 'noLimit');
});

const sources = [{ n: 1, url: 'https://a.example/p?x=1&y=2', title: 'A page', domain: 'a.example' }];

test('only retrieved sources become links', () => {
  const html = render('Real [1] and invented [7]. [Good](https://a.example/p?x=1&y=2) [Bad](https://evil.example)', sources);
  assert.match(html, /class="cite" data-n="1"/);
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, /href="https:\/\/a\.example\/p\?x=1&amp;y=2"/);
  assert.deepEqual(cited('Real [1] and invented [7]', sources), [1]);
});

test('model markup cannot inject HTML', () => {
  const html = render('<img src=x onerror=alert(1)> **bold** `<b>`', sources);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('gpt-oss citation style is understood and changes blocks are hidden', () => {
  assert.equal(normalizeCites('Price is $5【1†source】.'), 'Price is $5[1].');
  assert.deepEqual(splitChanges(`Hello\n${FENCE}changes\n[]\n${FENCE}`), { text: 'Hello', pending: false });
  assert.deepEqual(splitChanges(`Hello\n${FENCE}changes\n[{"item"`), { text: 'Hello', pending: true });
});

const cblock = (o) => `Answer.\n${FENCE}chart\n${JSON.stringify(o)}\n${FENCE}`;
const quotes = new Map([[1, 'NVDA 188.50 up 1.2% today'], [2, 'closes: Nov 3 186.2, Nov 4 187.9, Nov 5 188.5']]);

test('chart keeps only figures a source contains; series needs 3 real points', () => {
  const c = verifyChart(cblock({
    title: 'NVDA', unit: '$',
    stats: [{ label: 'Price', value: '$188.50', src: 1 }, { label: 'Cap', value: '$9T', src: 1 }],
    series: [{ x: 'Nov 3', y: 186.2, src: 2 }, { x: 'Nov 4', y: 187.9, src: 2 }, { x: 'Nov 5', y: 188.5, src: 2 }, { x: 'Nov 6', y: 999, src: 2 }],
  }), quotes);
  assert.deepEqual(c.stats.map((x) => x.label), ['Price']);
  assert.equal(c.series.length, 3);
});

test('chart: two real points are not a trend, and no block means no chart', () => {
  const c = verifyChart(cblock({ stats: [], series: [{ x: 'a', y: 186.2, src: 2 }, { x: 'b', y: 187.9, src: 2 }] }), quotes);
  assert.equal(c, null);
  assert.equal(verifyChart('Just prose.', quotes), null);
});
