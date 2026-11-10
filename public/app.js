import * as store from './store.js';
import { render, cited, splitChanges } from './md.js';
import { sampleThreads, samplePrompts } from './sample.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const ui = {
  app: $('#app'), transcript: $('#transcript'), scroll: $('#scroll'), threads: $('#threads'),
  input: $('#composer-input'), send: $('#send'), title: $('#title'), count: $('#count'),
};
let current = null; // thread id; null = a new chat that has not been saved yet
let busy = null; // AbortController of the running request

/* ---------- dates ---------- */
const sameDay = (a, b) => a.toDateString() === b.toDateString();
function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, new Date(now.getTime() - 86400000))) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) }).format(d);
}

/* ---------- rail and header ---------- */
function renderRail() {
  ui.threads.replaceChildren();
  let last = '';
  for (const t of store.threads()) {
    const label = dayLabel(t.updated);
    if (label !== last) { ui.threads.append(el('h2', 'day', label)); last = label; }
    const row = el('div', `thread${t.id === current ? ' on' : ''}`);
    const open = el('button', 'open', t.title || 'New chat');
    open.type = 'button';
    if (t.sample) open.append(el('span', 'tag', 'sample'));
    open.onclick = () => openThread(t.id);
    const del = el('button', 'del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete ${t.title || 'conversation'}`);
    del.onclick = () => { store.remove(t.id); if (current === t.id) newChat(); else renderRail(); updateHeader(); };
    row.append(open, del);
    ui.threads.append(row);
  }
}

function updateHeader() {
  const t = current && store.get(current);
  ui.title.textContent = t?.title || 'New chat';
  const n = store.countPairs();
  ui.count.textContent = n ? `${n} saved question${n === 1 ? '' : 's'} on this device` : 'Nothing saved yet';
}

/* ---------- turns ---------- */
function divider(iso) {
  return el('div', 'day-rule', dayLabel(iso));
}

function buildTurn(q) {
  const root = el('section', 'turn');
  const a = el('div', 'a');
  const notes = el('ol', 'notes');
  notes.setAttribute('aria-label', 'Sources');
  const body = el('div', 'body');
  body.append(a, notes);
  const meta = el('p', 'meta');
  root.append(el('h2', 'q', q), body, meta);
  return { root, a, notes, meta };
}

function ledgerEl(rows, sources, play) {
  const table = el('table', `ledger${play ? ' play' : ''}`);
  table.setAttribute('aria-label', 'Earlier answer compared with now');
  table.innerHTML = '<thead><tr><th>Item</th><th>Earlier</th><th>Now</th><th>Status</th></tr></thead>';
  const body = el('tbody');
  const bySrc = new Map(sources.map((s) => [s.n, s]));
  const label = { changed: 'Changed', same: 'Still current', unverified: "Couldn't confirm" };
  rows.forEach((r, i) => {
    const tr = el('tr', r.status);
    tr.style.setProperty('--i', i);
    const now = el('td', 'now', r.now && r.now !== 'unverified' ? r.now : '—');
    const s = bySrc.get(r.src);
    if (s && r.status !== 'unverified') {
      const a = el('a', 'cite', String(s.n));
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = `${s.title || s.domain} (${s.domain})`; a.dataset.n = s.n;
      now.append(' ', a);
    }
    const then = el('td', 'then');
    if (r.status === 'changed') then.append(el('s', '', r.then || '—')); else then.textContent = r.then || '—';
    const st = el('td', 'st', label[r.status]);
    if (r.reason) st.append(el('span', 'why', r.reason));
    tr.append(el('td', 'item', r.item), then, now, st);
    body.append(tr);
  });
  table.append(body);
  return table;
}

/** Paints one turn from its state. Cheap enough to run on every animation frame while streaming. */
function paint(t, s) {
  const { text, pending } = splitChanges(s.text);
  const usedSources = cited(s.text, s.sources);
  const live = s.status && !s.text ? `<p class="live"><span class="dot"></span><span></span></p>` : '';
  t.a.innerHTML = live + render(text, s.sources) + (pending ? '<p class="comparing">Comparing with your earlier answer…</p>' : '');
  if (live) t.a.querySelector('.live span:last-child').textContent = s.status;
  if (s.ledger?.length) t.a.append(ledgerEl(s.ledger, s.sources, s.play));

  t.notes.replaceChildren(...usedSources.map((n) => {
    const src = s.sources.find((x) => x.n === n);
    const li = el('li', 'note');
    li.dataset.n = n;
    const a = el('a');
    a.href = src.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.append(el('span', 'n', String(n)), el('span', 't', src.title || src.domain), el('span', 'd', [src.domain, src.date && new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(src.date))].filter(Boolean).join(' · ')));
    li.append(a);
    return li;
  }));
  t.notes.hidden = usedSources.length === 0;

  const m = s.meta;
  t.meta.textContent = m
    ? [`${(m.ms / 1000).toFixed(1)} s`, m.searches ? `${m.searches} search${m.searches === 1 ? '' : 'es'}, ${m.sources} sources read` : 'no search needed', m.recalled ? `used ${m.recalled} earlier conversation${m.recalled === 1 ? '' : 's'}` : null, m.provider ? `${m.provider.model.split('/').pop()} via ${m.provider.id}` : null].filter(Boolean).join(' · ')
    : '';
}

function showError(t, message, retry) {
  const box = el('div', 'error');
  box.append(el('p', '', 'Could not get an answer.'));
  const details = el('details');
  details.append(el('summary', '', 'Details'), el('p', '', message));
  const again = el('button', 'linkish', 'Try again');
  again.type = 'button';
  again.onclick = retry;
  box.append(details, again);
  t.a.replaceChildren(box);
}

/* ---------- transcript ---------- */
function renderTranscript() {
  ui.transcript.replaceChildren();
  const t = current && store.get(current);
  if (!t?.pairs.length) return ui.transcript.append(hero());
  let last = '';
  for (const p of t.pairs) {
    const label = dayLabel(p.ts);
    if (label !== last) { ui.transcript.append(divider(p.ts)); last = label; }
    const turn = buildTurn(p.q);
    paint(turn, { text: p.a, sources: p.sources ?? [], ledger: p.ledger, meta: p.meta, status: '' });
    ui.transcript.append(turn.root);
  }
  ui.scroll.scrollTop = ui.scroll.scrollHeight;
}

function hero() {
  const box = el('div', 'hero');
  box.append(el('h2', '', 'What changed since you last looked?'), el('p', '', 'Since reads the live web, remembers your questions on this device, and checks them again when you ask.'));
  const list = el('ul', 'prompts');
  for (const q of samplePrompts()) {
    const li = el('li');
    const b = el('button', '', q);
    b.type = 'button';
    b.onclick = () => send(q);
    li.append(b);
    list.append(li);
  }
  const hint = el('p', 'hint', 'The first one works right away. The other three refer to earlier conversations, so load the sample history first. ');
  const load = el('button', 'linkish', 'Load sample history');
  load.type = 'button';
  load.onclick = loadSample;
  hint.append(load);
  box.append(list, hint);
  return box;
}

/* ---------- actions ---------- */
function openThread(id) {
  if (busy) return;
  current = id;
  closeRail();
  renderRail(); updateHeader(); renderTranscript();
}
function newChat() {
  if (busy) return;
  current = null;
  closeRail();
  renderRail(); updateHeader(); renderTranscript();
  ui.input.focus();
}
function loadSample() {
  if (store.threads().some((t) => t.sample)) return;
  store.importThreads(sampleThreads());
  renderRail(); updateHeader();
  ui.input.value = '';
  ui.input.placeholder = 'Sample history loaded. Try: On Monday we shortlisted 5 CRM tools. Has any changed pricing since?';
  ui.input.focus();
}

async function readStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      const event = /^event: (.+)$/m.exec(part)?.[1];
      const data = /^data: (.+)$/m.exec(part)?.[1];
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}

function setBusy(on) {
  ui.send.textContent = on ? 'Stop' : 'Send';
  ui.send.disabled = !on && !ui.input.value.trim();
  ui.send.dataset.mode = on ? 'stop' : 'send';
}

async function send(text) {
  if (busy) return;
  text = text.trim();
  if (!text) return;

  let thread = current && store.get(current);
  if (!thread) { thread = store.newThread(); current = thread.id; }
  if (!thread.pairs.length) ui.transcript.replaceChildren();

  const pairId = store.uid();
  const ts = new Date().toISOString();
  const lastTs = thread.pairs.at(-1)?.ts;
  if (!lastTs || dayLabel(lastTs) !== dayLabel(ts)) ui.transcript.append(divider(ts));
  const turn = buildTurn(text);
  ui.transcript.append(turn.root);

  const s = { text: '', sources: [], status: 'Reading your question', ledger: null, meta: null, play: true };
  let frame = 0;
  const schedule = () => frame || (frame = requestAnimationFrame(() => {
    frame = 0;
    const stick = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 140;
    paint(turn, s);
    if (stick) ui.scroll.scrollTop = ui.scroll.scrollHeight;
  }));

  ui.input.value = '';
  ui.input.style.height = '';
  ui.input.placeholder = 'Ask anything. Since checks the web.';
  const ctl = new AbortController();
  busy = ctl;
  setBusy(true);
  paint(turn, s);
  ui.scroll.scrollTop = ui.scroll.scrollHeight;

  let vectors = null;
  let failed = null;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ message: text, tz, pairId, ...store.payload(thread.id) }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    await readStream(res, (event, d) => {
      if (event === 'status') s.status = d.text;
      else if (event === 'sources') s.sources = d.items;
      else if (event === 'delta') { s.text += d.text; s.status = ''; }
      else if (event === 'ledger') s.ledger = d.rows;
      else if (event === 'vectors') vectors = d.vectors;
      else if (event === 'done') s.meta = d;
      else if (event === 'error') throw new Error(d.message);
      schedule();
    });
  } catch (e) {
    if (e.name !== 'AbortError') failed = e.message;
  }

  cancelAnimationFrame(frame);
  frame = 0;
  s.status = '';
  busy = null;
  if (failed && !s.text.trim()) {
    showError(turn, failed, () => { turn.root.remove(); if (!thread.pairs.length) store.remove(thread.id); current = thread.pairs.length ? thread.id : null; send(text); });
  } else {
    if (failed) s.text += `\n\n(Stopped: ${failed})`;
    paint(turn, s);
    if (s.text.trim()) {
      store.addPair(thread.id, { id: pairId, ts, q: text, a: s.text, sources: s.sources, ledger: s.ledger ?? undefined, meta: s.meta ?? undefined });
      if (vectors) store.applyVectors(vectors);
    }
  }
  setBusy(false);
  renderRail(); updateHeader();
  ui.input.focus();
}

/* ---------- wiring ---------- */
ui.send.addEventListener('click', (e) => { if (busy) { e.preventDefault(); busy.abort(); } });
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); if (!busy) send(ui.input.value); });
ui.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(ui.input.value); }
  if (e.key === 'Escape' && busy) busy.abort();
});
ui.input.addEventListener('input', () => {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 160)}px`;
  if (!busy) ui.send.disabled = !ui.input.value.trim();
});

// A citation and its margin note light up together.
const note = (target) => target.closest('.turn')?.querySelector(`.note[data-n="${target.dataset.n}"]`);
ui.transcript.addEventListener('mouseover', (e) => e.target.classList?.contains('cite') && note(e.target)?.classList.add('hot'));
ui.transcript.addEventListener('mouseout', (e) => e.target.classList?.contains('cite') && note(e.target)?.classList.remove('hot'));
ui.transcript.addEventListener('focusin', (e) => e.target.classList?.contains('cite') && note(e.target)?.classList.add('hot'));
ui.transcript.addEventListener('focusout', (e) => e.target.classList?.contains('cite') && note(e.target)?.classList.remove('hot'));

const closeRail = () => { ui.app.classList.remove('rail-open'); $('#menu').setAttribute('aria-expanded', 'false'); };
$('#menu').onclick = () => { const open = ui.app.classList.toggle('rail-open'); $('#menu').setAttribute('aria-expanded', String(open)); };
$('#scrim').onclick = closeRail;
$('#new-chat').onclick = newChat;
$('#load-sample').onclick = loadSample;

let armed = 0;
$('#clear-all').onclick = (e) => {
  if (!armed) {
    e.target.textContent = 'Click again to clear';
    armed = setTimeout(() => { armed = 0; e.target.textContent = 'Clear memory'; }, 3000);
    return;
  }
  clearTimeout(armed); armed = 0;
  e.target.textContent = 'Clear memory';
  store.clear();
  newChat();
};

setBusy(false);
renderRail(); updateHeader(); renderTranscript();
