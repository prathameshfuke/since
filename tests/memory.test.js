import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recall } from '../server/memory.js';
import { resolveDates } from '../server/dates.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-10T10:00:00Z');
const pair = (id, ts, q, a = '') => ({ id, ts, q, a });
const history = [
  pair('crm', '2026-11-09T05:00:00Z', 'We are shortlisting CRM tools for a 20-person sales team: HubSpot, Pipedrive, Close', 'HubSpot Starter costs about $20 per seat per month.'),
  pair('pg', '2026-11-03T05:00:00Z', 'Compare Postgres hosting for a small SaaS: Neon, Supabase, Railway', 'Neon free plan 0.5 GB. Supabase Pro $25.'),
  pair('misc', '2026-11-03T08:00:00Z', 'What is a good name for a bakery?', 'Try Crumb & Co.'),
];
const run = (query, extra = {}) => recall({ query, pairs: history, refs: resolveDates(query, NOW, TZ).refs, tz: TZ, ...extra });

test('an exact date returns that day, however the user phrased it', () => {
  const { hits, dated } = run('What did I ask you on 3 November?');
  assert.equal(dated, true);
  assert.deepEqual(hits.map((p) => p.id), ['pg', 'misc']); // chronological
});

test('"On Monday we shortlisted CRM tools" finds the Monday conversation', () => {
  const { hits } = run('On Monday we shortlisted 5 CRM tools. Has any changed pricing since?');
  assert.deepEqual(hits.map((p) => p.id), ['crm']);
});

test('a date with no conversation says so instead of guessing', () => {
  const { hits, note } = run('What did I ask you on 1 November?');
  assert.deepEqual(hits, []);
  assert.match(note, /no stored conversation falls on that date/);
});

test('with no date, matching words find the topic and ignore the rest', () => {
  const { hits, dated } = run('that Postgres hosting comparison, has Neon changed?');
  assert.equal(dated, false);
  assert.deepEqual(hits.map((p) => p.id), ['pg']);
});

test('unrelated questions recall nothing', () => {
  assert.deepEqual(run('Who won the 2022 football world cup?').hits, []);
});

test('turns already in the live conversation are not recalled twice', () => {
  const { hits } = run('Neon Postgres hosting', { skip: new Set(['pg']) });
  assert.deepEqual(hits, []);
});

test('similar vectors outrank keywords alone', () => {
  const near = [1, 0, 0];
  const withVec = [{ ...pair('v', '2026-11-02T05:00:00Z', 'database vendors'), vec: near }];
  const { hits } = recall({ query: 'x', qvec: [0.99, 0.1, 0], pairs: withVec, refs: [], tz: TZ });
  assert.equal(hits.length, 1);
});
