// HTTP server with no framework: static files, POST /api/chat (server-sent events), GET /api/health.
// The server keeps no conversation state. The browser sends the history it wants considered.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.js';
import { configured } from './llm.js';
import { DIMS } from './embed.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const MAX_BODY = 3 * 1024 * 1024;
const RATE = { windowMs: 60_000, max: 20 };
const hits = new Map(); // ip -> request timestamps in the window

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
};

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE.max;
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', ...HEADERS });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large. Clear some saved history and try again.'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const turn = (p) => ({
  id: str(p?.id, 64),
  ts: Number.isNaN(Date.parse(p?.ts)) ? new Date(0).toISOString() : new Date(p.ts).toISOString(),
  q: str(p?.q, 1500),
  a: str(p?.a, 1500),
  vec: Array.isArray(p?.vec) && p.vec.length === DIMS && p.vec.every(Number.isFinite) ? p.vec : undefined,
});

function sanitize(b) {
  const message = str(b.message, 4000).trim();
  if (!message) throw Object.assign(new Error('Write a message first.'), { status: 400 });
  let tz = str(b.tz, 64) || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = 'UTC'; }
  return {
    message,
    tz,
    pairId: str(b.pairId, 64),
    recent: (Array.isArray(b.recent) ? b.recent : []).slice(-6).map(turn),
    memory: (Array.isArray(b.memory) ? b.memory : []).slice(-300).map(turn).filter((p) => p.id && p.q),
  };
}

async function chat(req, res) {
  const ip = req.socket.remoteAddress ?? '?';
  if (limited(ip)) return json(res, 429, { error: 'Too many requests. Wait a minute and try again.' });
  let input;
  try { input = sanitize(await readBody(req)); } catch (e) { return json(res, e.status || 400, { error: e.status ? e.message : 'Send JSON: {"message": "..."}' }); }

  const ctl = new AbortController();
  res.on('close', () => ctl.abort(new Error('client closed')));
  const wantsJson = (req.headers.accept || '').includes('application/json') && !(req.headers.accept || '').includes('text/event-stream');

  if (wantsJson) {
    let answer = '';
    const out = { sources: [], meta: null };
    try {
      for await (const { event, data } of runAgent({ ...input, signal: ctl.signal })) {
        if (event === 'delta') answer += data.text;
        else if (event === 'sources') out.sources = data.items;
        else if (event === 'done') out.meta = data;
      }
      return json(res, 200, { answer, ...out });
    } catch (e) { return json(res, 502, { error: e.message }); }
  }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...HEADERS });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const beat = setInterval(() => res.write(': ping\n\n'), 15_000); // keeps proxies from closing a quiet stream
  try {
    for await (const { event, data } of runAgent({ ...input, signal: ctl.signal })) send(event, data);
  } catch (e) {
    if (!ctl.signal.aborted) send('error', { message: e.message });
  } finally {
    clearInterval(beat);
    res.end();
  }
}

async function serveStatic(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  const file = normalize(join(PUBLIC, path === '/' ? 'index.html' : path));
  if (!file.startsWith(PUBLIC.endsWith(sep) ? PUBLIC : PUBLIC + sep)) return json(res, 403, { error: 'Forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...HEADERS });
    res.end(body);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (req.method === 'POST' && pathname === '/api/chat') return await chat(req, res);
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        models: configured().map((p) => `${p.id}:${p.model}`),
        search: [process.env.LANGSEARCH_API_KEY && 'langsearch', process.env.TAVILY_API_KEY && 'tavily'].filter(Boolean),
        embeddings: Boolean(process.env.GEMINI_API_KEY),
      });
    }
    if (req.method === 'GET') return await serveStatic(req, res);
    json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
    else res.end();
    console.error(e);
  }
});

server.listen(PORT, () => {
  console.log(`Since is running at http://localhost:${PORT}`);
  const missing = ['GROQ_API_KEY', 'LANGSEARCH_API_KEY', 'GEMINI_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) console.warn(`Missing in .env: ${missing.join(', ')} (see .env.example)`);
});
