import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDates, dayKey } from '../server/dates.js';

// Tuesday 10 November 2026, 15:30 in Kolkata.
const NOW = new Date('2026-11-10T10:00:00Z');
const ranges = (text, now = NOW, tz = 'Asia/Kolkata') => resolveDates(text, now, tz).refs.map((r) => [r.start, r.end]);

test('weekday names mean the most recent one before today', () => {
  assert.deepEqual(ranges('On Monday we shortlisted 5 CRM tools'), [['2026-11-09', '2026-11-09']]);
  assert.deepEqual(ranges('Last Tuesday I asked about Postgres hosting'), [['2026-11-03', '2026-11-03']]); // today is Tuesday
  assert.deepEqual(ranges('since friday'), [['2026-11-06', '2026-11-06']]);
});

test('"last Tuesday" on a Wednesday keeps both candidates', () => {
  const wed = new Date('2026-11-11T10:00:00Z');
  const [ref] = resolveDates('Last Tuesday I asked about Postgres hosting', wed, 'Asia/Kolkata').refs;
  assert.deepEqual([ref.start, ref.alt], ['2026-11-10', '2026-11-03']);
  assert.equal(resolveDates('on Tuesday', wed, 'UTC').refs[0].alt, undefined); // bare weekday is not ambiguous
});

test('"this <today\'s weekday>" is today', () => {
  assert.deepEqual(ranges('this Tuesday'), [['2026-11-10', '2026-11-10']]);
});

test('absolute dates, with and without year', () => {
  assert.deepEqual(ranges('What did I ask you on 3 November?'), [['2026-11-03', '2026-11-03']]);
  assert.deepEqual(ranges('Nov 3rd'), [['2026-11-03', '2026-11-03']]);
  assert.deepEqual(ranges('3rd Nov 2025'), [['2025-11-03', '2025-11-03']]);
  assert.deepEqual(ranges('2026-10-31'), [['2026-10-31', '2026-10-31']]);
  assert.deepEqual(ranges('on 25 December'), [['2025-12-25', '2025-12-25']]); // not yet reached this year
});

test('relative phrases', () => {
  assert.deepEqual(ranges('yesterday'), [['2026-11-09', '2026-11-09']]);
  assert.deepEqual(ranges('two days ago'), [['2026-11-08', '2026-11-08']]);
  assert.deepEqual(ranges('last week'), [['2026-11-02', '2026-11-08']]);
  assert.deepEqual(ranges('last month'), [['2026-10-01', '2026-10-31']]);
});

test('the timezone decides what "today" is', () => {
  const lateUtc = new Date('2026-11-10T20:00:00Z'); // already 11 Nov in Kolkata
  assert.equal(resolveDates('hi', lateUtc, 'Asia/Kolkata').today, '2026-11-11');
  assert.equal(resolveDates('hi', lateUtc, 'UTC').today, '2026-11-10');
  assert.deepEqual(ranges('yesterday', lateUtc, 'Asia/Kolkata'), [['2026-11-10', '2026-11-10']]);
});

test('nothing is invented', () => {
  assert.deepEqual(ranges('you may use it'), []); // "may" the verb is not a month
  assert.deepEqual(ranges('30 February'), []);
  assert.deepEqual(ranges('Compare Neon and Supabase pricing'), []);
});

test('each phrase is counted once', () => {
  assert.equal(resolveDates('last Tuesday', NOW, 'UTC').refs.length, 1);
  assert.equal(resolveDates('since 3 November and again yesterday', NOW, 'UTC').refs.length, 2);
});

test('dayKey falls back to UTC on a bad timezone', () => {
  assert.equal(dayKey(NOW, 'Not/AZone'), '2026-11-10');
});
