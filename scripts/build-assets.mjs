// Builds the README banner, social preview and wordmark as SVG + PNG, in the app's own style.
// Text is converted to outlines so the files look identical on GitHub, which does not load web fonts
// inside images. Dev-only tooling, kept out of package.json so the app stays dependency-free:
//
//   npm i --no-save fontkit @fontsource/newsreader @fontsource/instrument-sans @resvg/resvg-js
//   node scripts/build-assets.mjs

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as fontkit from 'fontkit';
import { Resvg } from '@resvg/resvg-js';

const require = createRequire(import.meta.url);
const face = (pkg, file) => fontkit.create(readFileSync(require.resolve(`${pkg}/files/${file}`)));
const serif = face('@fontsource/newsreader', 'newsreader-latin-400-normal.woff');
const sans = face('@fontsource/instrument-sans', 'instrument-sans-latin-500-normal.woff');
const sansBold = face('@fontsource/instrument-sans', 'instrument-sans-latin-700-normal.woff');

const THEMES = {
  light: { bg: '#FAFAFC', ink: '#1A1A1F', soft: '#55576A', rule: '#E6E7EE', paper: '#FFFFFF', glow1: '#F97316', glow1a: 0.8, glow3: '#8BA0FA', glow3a: 0.55, grain: '#000000', grainA: 0.07, tide: '#0A7566', flare: '#B5194F', straw: '#8A6700' },
  dark: { bg: '#0E0F16', ink: '#ECEDF4', soft: '#A9ABBE', rule: '#2A2B38', paper: '#14151E', glow1: '#F97316', glow1a: 0.5, glow3: '#6366F1', glow3a: 0.38, grain: '#FFFFFF', grainA: 0.09, tide: '#46D1BD', flare: '#FF7AA3', straw: '#F0C84A' },
};

/**
 * Lays glyphs out by hand (advance + kerning + letter-spacing in em). opentype.js's own shaper throws on
 * the contextual-substitution tables in these fonts, and display text does not need ligatures.
 */
function shape(font, str, size, ls = 0) {
  const scale = size / font.unitsPerEm;
  const run = font.layout(str); // fontkit applies the font's own kerning and substitutions
  const items = [];
  let x = 0;
  run.glyphs.forEach((g, i) => {
    const p = run.positions[i];
    items.push({ g, x: x + p.xOffset * scale, yOff: p.yOffset * scale });
    x += p.xAdvance * scale + ls * size;
  });
  return { items, width: x - ls * size, scale };
}
const measure = (font, str, size, ls = 0) => shape(font, str, size, ls).width;

/** Text as an outlined <path>. anchor: start | middle | end. `ls` is letter-spacing in em. */
function text(font, str, x, y, size, fill, { anchor = 'start', ls = 0 } = {}) {
  const { items, width, scale } = shape(font, str, size, ls);
  const x0 = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  // Font outlines are y-up in font units, so each glyph is scaled and flipped into place.
  const paths = items.map(({ g, x: gx, yOff }) => {
    const d = g.path.toSVG();
    return d ? `<path transform="translate(${(x0 + gx).toFixed(2)} ${(y - yOff).toFixed(2)}) scale(${scale.toFixed(5)} ${(-scale).toFixed(5)})" d="${d}"/>` : '';
  });
  return `<g fill="${fill}">${paths.join('')}</g>`;
}

const mark = (x, y, s, id) => `
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="0.7" y2="1"><stop offset="0" stop-color="#F97316"/><stop offset="0.55" stop-color="#F2A58E"/><stop offset="1" stop-color="#8BA0FA"/></linearGradient></defs>
  <g transform="translate(${x} ${y}) scale(${s / 64})">
    <rect width="64" height="64" rx="18" fill="url(#${id})"/>
    <circle cx="19" cy="32" r="7.2" fill="none" stroke="#fff" stroke-width="3.8"/>
    <path d="M27.5 32h16" stroke="#fff" stroke-width="3.8" stroke-linecap="round"/>
    <circle cx="47.5" cy="32" r="6.8" fill="#16172F"/>
  </g>`;

const wash = (t, w, h) => `
  <defs>
    <radialGradient id="o" gradientUnits="userSpaceOnUse" cx="${w / 2}" cy="${-h * 0.1}" r="${w * 0.62}"><stop offset="0" stop-color="${t.glow1}" stop-opacity="${t.glow1a}"/><stop offset="1" stop-color="${t.glow1}" stop-opacity="0"/></radialGradient>
    <radialGradient id="l" gradientUnits="userSpaceOnUse" cx="0" cy="${h * 0.3}" r="${w * 0.4}"><stop offset="0" stop-color="${t.glow3}" stop-opacity="${t.glow3a}"/><stop offset="1" stop-color="${t.glow3}" stop-opacity="0"/></radialGradient>
    <radialGradient id="r" gradientUnits="userSpaceOnUse" cx="${w}" cy="${h * 0.3}" r="${w * 0.4}"><stop offset="0" stop-color="${t.glow3}" stop-opacity="${t.glow3a}"/><stop offset="1" stop-color="${t.glow3}" stop-opacity="0"/></radialGradient>
    <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${t.grain === '#FFFFFF' ? 1 : 0} 0 0 0 0 ${t.grain === '#FFFFFF' ? 1 : 0} 0 0 0 0 ${t.grain === '#FFFFFF' ? 1 : 0} 0 0 0 0.9 0"/></filter>
  </defs>
  <rect width="${w}" height="${h}" fill="${t.bg}"/>
  <rect width="${w}" height="${h}" fill="url(#o)"/><rect width="${w}" height="${h}" fill="url(#l)"/><rect width="${w}" height="${h}" fill="url(#r)"/>`;

const grainOverlay = (t, w, h) => `<rect width="${w}" height="${h}" filter="url(#grain)" opacity="${t.grainA}"/>`;

function pill(t, x, y, label, color, glyph) {
  const padL = 40, padR = 22, size = 22;
  const w = padL + measure(sans, label, size) + padR;
  const g = glyph === 'square' ? `<rect x="${x + 18}" y="${y - 7}" width="13" height="13" fill="${color}"/>`
    : glyph === 'circle' ? `<circle cx="${x + 24.5}" cy="${y - 0.5}" r="6.5" fill="${color}"/>`
    : `<circle cx="${x + 24.5}" cy="${y - 0.5}" r="5.5" fill="none" stroke="${color}" stroke-width="2.4" stroke-dasharray="3.4 2.6"/>`;
  return { w, svg: `<rect x="${x}" y="${y - 25}" width="${w}" height="50" rx="25" fill="${t.paper}" fill-opacity="0.75" stroke="${t.rule}"/>${g}${text(sans, label, x + padL, y + 7, size, t.ink)}` };
}

function banner(name) {
  const t = THEMES[name];
  const W = 1280, H = 640;
  const pills = [['Still current', t.tide, 'circle'], ['Changed', t.flare, 'square'], ["Couldn't confirm", t.straw, 'ring']].map(([l, c, g]) => pill(t, 0, 0, l, c, g));
  const total = pills.reduce((s, p) => s + p.w, 0) + 16 * (pills.length - 1);
  let cx = (W - total) / 2;
  const row = ['Still current', 'Changed', "Couldn't confirm"].map((l, i) => {
    const [, c, g] = [0, [t.tide, t.flare, t.straw][i], ['circle', 'square', 'ring'][i]];
    const p = pill(t, cx, 538, l, c, g);
    cx += p.w + 16;
    return p.svg;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Since: a chat agent that remembers what you asked and checks what changed.">
  ${wash(t, W, H)}
  ${mark(W / 2 - 36, 96, 72, 'm')}
  ${text(serif, 'What changed since', W / 2, 258, 78, t.ink, { anchor: 'middle', ls: -0.03 })}
  ${text(serif, 'you last looked?', W / 2, 342, 78, t.ink, { anchor: 'middle', ls: -0.03 })}
  ${text(sans, 'A chat agent with one tool, web search. It remembers what you asked and re-checks it later.', W / 2, 424, 25, t.soft, { anchor: 'middle' })}
  ${row}
  ${grainOverlay(t, W, H)}
</svg>`;
}

function wordmark(name) {
  const t = THEMES[name];
  const W = 420, H = 120;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="since">
  ${mark(8, 16, 88, 'w')}
  ${text(sansBold, 'since', 118, 82, 68, t.ink, { ls: -0.04 })}
</svg>`;
}

/* ---------- diagrams ---------- */
const mono = face('@fontsource/dm-mono', 'dm-mono-latin-400-normal.woff');

const frame = (t, w, h, body) => {
  const soft = { ...t, glow1a: t.glow1a * 0.45, glow3a: t.glow3a * 0.5 };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${wash(soft, w, h)}
  <defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1.5 8.5 5 1 8.5" fill="none" stroke="${t.soft}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
  ${body}
  ${grainOverlay(t, w, h)}
</svg>`;
};

const group = (t, x, y, w, h, label) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${t.paper}" fill-opacity="0.35" stroke="${t.rule}"/>${text(mono, label, x + 24, y + 31, 14, t.soft)}`;

const card = (t, x, y, w, title, lines) => {
  const h = 52 + lines.length * 22;
  return { h, svg: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${t.paper}" fill-opacity="0.85" stroke="${t.rule}"/>${text(sansBold, title, x + 20, y + 33, 17, t.ink)}${lines.map((l, i) => text(sans, l, x + 20, y + 60 + i * 22, 14.5, t.soft)).join('')}` };
};

const step = (t, x, y, w, h, n, title, lines) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${t.paper}" fill-opacity="0.9" stroke="${t.rule}"/>
   <circle cx="${x + 28}" cy="${y + 30}" r="13" fill="${t.ink}"/>${text(sansBold, String(n), x + 28, y + 35, 14, t.bg, { anchor: 'middle' })}
   ${text(sansBold, title, x + 50, y + 36, 16.5, t.ink)}${lines.map((l, i) => text(sans, l, x + 20, y + 68 + i * 20, 13.5, t.soft)).join('')}`;

const arrow = (t, x1, y1, x2, y2) => `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${t.soft}" stroke-width="1.6" fill="none" stroke-linecap="round" marker-end="url(#ah)"/>`;
const title = (t, head, sub) => text(serif, head, 60, 82, 40, t.ink, { ls: -0.02 }) + text(sans, sub, 60, 118, 18, t.soft);

function architecture(name) {
  const t = THEMES[name];
  const W = 1280, H = 920;
  let b = title(t, 'How Since answers', 'One request, six steps, three kinds of provider. The server keeps nothing.');

  b += group(t, 60, 150, 1160, 150, 'Your browser');
  for (const [x, w, head, lines] of [
    [84, 330, 'Chat', ['Streams tokens as they arrive', 'Dated transcript, source chips']],
    [434, 360, 'Ledger', ['Earlier value, current value, status', 'Still current · Changed · Couldn’t confirm']],
    [814, 382, 'Memory (this device)', ['Turns, vectors and ledgers in localStorage', 'History is sent only when you ask']],
  ]) b += card(t, x, 192, w, head, lines).svg;

  b += arrow(t, 330, 300, 330, 360) + text(mono, 'POST /api/chat', 346, 326, 13.5, t.ink) + text(mono, 'message, time zone, saved history', 346, 346, 12.5, t.soft);
  b += arrow(t, 930, 360, 930, 300) + text(mono, 'server-sent events', 946, 326, 13.5, t.ink) + text(mono, 'status, sources, delta, ledger, done', 946, 346, 12.5, t.soft);

  b += group(t, 60, 360, 1160, 340, 'Server · stateless Node (npm run dev, or a Vercel function)');
  const steps = [
    ['Dates', ['Resolves “Monday”,', '“last Tuesday”, “3 Nov”', 'in code, by time zone']],
    ['Recall', ['Exact date first, then', 'meaning (embeddings)', 'fused with BM25']],
    ['Plan', ['Small model: search or', 'not, one query per', 'item, with a date floor']],
    ['Search', ['All queries in parallel:', 'Tavily now, LangSearch', 'since a date, reranked']],
    ['Answer', ['Main model streams,', 'cites [n], may search', 'once more if needed']],
    ['Verify', ['A row says same or', 'changed only if the cited', 'text contains the figure']],
  ];
  steps.forEach(([head, lines], i) => {
    const x = 84 + i * 186;
    b += step(t, x, 404, 172, 116, i + 1, head, lines);
    if (i < steps.length - 1) b += arrow(t, x + 174, 462, x + 184, 462);
  });
  b += card(t, 84, 548, 560, 'Model router', ['gpt-oss-120b, then gpt-oss-20b, Gemini, OpenRouter', 'Timeouts, cooldowns, failover before the first token']).svg;
  b += card(t, 664, 548, 532, 'Guards', ['Rate limit, size cap, proof-of-work session', 'Only retrieved URLs become links · nothing stored']).svg;

  b += arrow(t, 640, 700, 640, 752) + text(mono, 'HTTPS, free tiers', 656, 733, 13, t.soft);
  b += group(t, 60, 752, 1160, 140, 'Providers');
  for (const [x, w, head, lines] of [
    [84, 370, 'Models', ['Groq · Gemini · OpenRouter']],
    [474, 330, 'Web search', ['Tavily · LangSearch']],
    [824, 372, 'Embeddings', ['Gemini embedding-001, 384 dimensions']],
  ]) b += card(t, x, 794, w, head, lines).svg;
  return frame(t, W, H, b);
}

function userFlow(name) {
  const t = THEMES[name];
  const W = 1280, H = 860;
  let b = title(t, 'What happens when you ask', 'From a question to a checked, cited answer, and what Since keeps for next time.');

  const stages = [
    ['You ask', ['Type a question or', 'pick a suggestion.', '']],
    ['Remembers', ['Finds the earlier chat', 'by date, else by', 'meaning.']],
    ['Plans', ['Decides if the web is', 'needed. One query', 'per thing to check.']],
    ['Searches', ['All queries at once,', 'newest evidence', 'first.']],
    ['Answers', ['Streams a cited answer;', 'sources appear', 'as chips.']],
    ['Verifies', ['Checks each ledger row', 'against its source,', 'then saves the turn.']],
  ];
  stages.forEach(([head, lines], i) => {
    const x = 51 + i * 200;
    b += step(t, x, 160, 178, 124, i + 1, head, lines);
    if (i < stages.length - 1) b += arrow(t, x + 180, 222, x + 198, 222);
  });

  b += text(serif, 'Three kinds of question, three paths', 60, 360, 28, t.ink, { ls: -0.015 });
  const lanes = [
    ['A plain question', '“What is the latest Node.js?”', 'about 1.5 to 4 s', ['Ask', 'Plan: search', 'Answer with sources']],
    ['Asking about the past', '“What did I ask on 3 November?”', 'about 6 s', ['Ask', 'Recall by date', 'State it, re-check it']],
    ['A change check', '“Did any of these change since Monday?”', 'about 6 to 12 s', ['Ask', 'Recall', 'Plan 5 queries', 'Search in parallel', 'Answer + ledger']],
  ];
  lanes.forEach(([head, example, time, chips], r) => {
    const y = 392 + r * 104;
    b += `<rect x="51" y="${y}" width="1178" height="88" rx="18" fill="${t.paper}" fill-opacity="0.35" stroke="${t.rule}"/>`;
    b += text(sansBold, head, 76, y + 36, 17, t.ink) + text(mono, example, 76, y + 60, 12.5, t.soft) + text(mono, time, 76, y + 78, 12.5, t.soft);
    let x = 400;
    chips.forEach((c, i) => {
      const w = Math.max(120, measure(sans, c, 15) + 36);
      const last = i === chips.length - 1;
      b += `<rect x="${x}" y="${y + 22}" width="${w}" height="44" rx="22" fill="${last ? t.ink : t.paper}" fill-opacity="${last ? 1 : 0.9}" stroke="${last ? t.ink : t.rule}"/>${text(sans, c, x + w / 2, y + 50, 15, last ? t.bg : t.ink, { anchor: 'middle' })}`;
      x += w;
      if (!last) { b += arrow(t, x + 4, y + 44, x + 22, y + 44); x += 26; }
    });
  });

  b += text(serif, 'How to read the ledger', 60, 746, 28, t.ink, { ls: -0.015 });
  [
    ['Still current', t.tide, 'circle', 'A cited source states the figure.'],
    ['Changed', t.flare, 'square', 'The earlier value differs and a source states the new one.'],
    ["Couldn't confirm", t.straw, 'ring', 'No cited source states it, so Since says so.'],
  ].forEach(([label, color, glyph], i) => {
    const x = 60 + i * 392;
    const p = pill(t, x, 794, label, color, glyph);
    b += p.svg + text(sans, i === 1 ? 'The earlier value differs, and a source states the new one.' : (i === 0 ? 'A cited source states the figure.' : 'No cited source states it, so Since says so.'), x + 6, 840, 13.5, t.soft);
  });
  return frame(t, W, H, b);
}

mkdirSync('docs/assets', { recursive: true });
const png = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
for (const name of Object.keys(THEMES)) {
  const svg = banner(name);
  writeFileSync(`docs/assets/banner-${name}.svg`, svg);
  writeFileSync(`docs/assets/banner-${name}.png`, png(svg, 1280));
  for (const [file, make] of [['architecture', architecture], ['user-flow', userFlow]]) {
    const d = make(name);
    writeFileSync(`docs/assets/${file}-${name}.svg`, d);
  }
  const wm = wordmark(name);
  writeFileSync(`docs/assets/wordmark-${name}.svg`, wm);
  writeFileSync(`docs/assets/wordmark-${name}.png`, png(wm, 840));
}
writeFileSync('docs/assets/social-preview.png', png(banner('light'), 1280)); // upload under Settings > Social preview
console.log('wrote docs/assets/*');
