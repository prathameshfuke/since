// Sample history, so a first-time visitor can try "has it changed since..." right away.
// The figures are illustrative and deliberately a little out of date. They are labelled "sample"
// in the UI, and the agent checks them against the live web.

import { uid } from './store.js';

const DAY_MS = 86400000;
const at = (date, hour, minute) => { const d = new Date(date); d.setHours(hour, minute, 0, 0); return d; };

/** Most recent given weekday (0 = Sunday) strictly before today. */
function lastWeekday(now, wd) {
  const back = ((now.getDay() - wd + 7) % 7) || 7;
  return new Date(now.getTime() - back * DAY_MS);
}

/** Tuesday of the previous calendar week (Monday-first). Covers both readings of "last Tuesday". */
function tuesdayLastWeek(now) {
  const sinceMonday = (now.getDay() + 6) % 7;
  return new Date(now.getTime() - (sinceMonday + 6) * DAY_MS);
}

const fmt = (d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' }).format(d);

export function samplePrompts(now = new Date()) {
  return [
    'Compare Postgres hosting for a small SaaS: Neon, Supabase, Render and Railway.',
    'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    `What did I ask you on ${fmt(tuesdayLastWeek(now))}? Is your answer still correct today?`,
    'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
  ];
}

export function sampleThreads(now = new Date()) {
  const crmAt = at(lastWeekday(now, 1), 10, 30).toISOString();
  const pgAt = at(tuesdayLastWeek(now), 15, 10).toISOString();
  const mk = (title, ts, q, a) => ({ id: uid(), title, created: ts, updated: ts, sample: true, pairs: [{ id: uid(), ts, q, a, sources: [] }] });
  return [
    mk('CRM shortlist', crmAt,
      'We are shortlisting 5 CRM tools for a 20-person sales team: HubSpot, Pipedrive, Salesforce, Zoho CRM and Close. What does each cost per seat?',
      'Approximate monthly prices per seat on the entry paid plan: HubSpot Sales Hub Starter about $20, Pipedrive Essential about $14, Salesforce Starter about $25, Zoho CRM Standard about $14, Close Startup about $29. For 20 seats, HubSpot Starter comes to roughly $400 a month and Pipedrive Essential to roughly $280.'),
    mk('Postgres hosting', pgAt,
      'Compare Postgres hosting for a small SaaS: Neon, Supabase, Render and Railway.',
      'Neon has a free plan with 0.5 GB of storage and paid plans from about $5 a month. Supabase Pro starts at $25 a month per project. Render Postgres starts around $6 a month. Railway bills by usage with a $5 monthly minimum.'),
  ];
}
