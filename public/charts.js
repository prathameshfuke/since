// Draws a verified chart block. The server has already dropped every figure its source did not contain;
// this file only draws. Six kinds: line, area, columns, bars (horizontal), scatter, pie.
const NS = 'http://www.w3.org/2000/svg';
const html = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const svg = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const num = (v) => Number(v.toFixed(2));
const W = 640, H = 220, L = 8, R = 58, T = 12, B = 28;

const pad = (lo, hi) => { const p = (hi - lo || Math.abs(hi) * 0.02 || 1) * 0.12; return [lo - p, hi + p]; };

function frame(c, label) {
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  return g;
}

function axisY(g, c, lo, hi, py) {
  for (const v of [lo, (lo + hi) / 2, hi]) {
    g.append(svg('line', { x1: L, x2: W - R, y1: py(v), y2: py(v), class: 'grid' }));
    g.append(svg('text', { x: W - R + 6, y: py(v) + 4, class: 'tick' }, `${c.unit || ''}${num(v)}`));
  }
}

function lineOrArea(c, pts, area) {
  const ys = pts.map((p) => p.y);
  const [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const px = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const py = (v) => T + ((y1 - v) * (H - T - B)) / (y1 - y0);
  const g = frame(c, `${c.title || 'Chart'}: ${pts[0].x} to ${pts.at(-1).x}, ${ys[0]} to ${ys.at(-1)}`);
  axisY(g, c, Math.min(...ys), Math.max(...ys), py);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(p.y).toFixed(1)}`).join(' ');
  if (area) g.append(svg('path', { d: `${d} L${px(pts.length - 1)} ${H - B} L${px(0)} ${H - B} Z`, class: 'area' }));
  g.append(svg('path', { d, class: 'line', pathLength: 1 }));
  g.append(svg('circle', { cx: px(pts.length - 1), cy: py(ys.at(-1)), r: 3.5, class: 'dot' }));
  g.append(svg('text', { x: L, y: H - 6, class: 'tick' }, pts[0].x));
  g.append(svg('text', { x: W - R, y: H - 6, class: 'tick', 'text-anchor': 'end' }, pts.at(-1).x));
  pts.forEach((p, i) => { const t = svg('circle', { cx: px(i), cy: py(p.y), r: 8, class: 'hit' }); t.append(svg('title', {}, `${p.x}: ${c.unit || ''}${p.y}`)); g.append(t); });
  return g;
}

function columns(c, pts) {
  const hi = Math.max(...pts.map((p) => p.y), 0), lo = Math.min(...pts.map((p) => p.y), 0);
  const [y0, y1] = [lo < 0 ? lo * 1.1 : 0, hi * 1.1 || 1];
  const py = (v) => T + ((y1 - v) * (H - T - B)) / (y1 - y0);
  const step = (W - L - R) / pts.length, bw = Math.min(46, step * 0.6);
  const g = frame(c, `${c.title || 'Chart'}: ${pts.map((p) => `${p.x} ${p.y}`).join(', ')}`);
  axisY(g, c, y0, y1 === 0 ? 1 : hi, py);
  pts.forEach((p, i) => {
    const x = L + step * i + (step - bw) / 2, top = py(Math.max(p.y, 0)), base = py(0);
    const r = svg('rect', { x, y: top, width: bw, height: Math.max(1, Math.abs(base - top) || (py(p.y) - base)), class: 'col', style: `--i:${i}` });
    r.append(svg('title', {}, `${p.x}: ${c.unit || ''}${p.y}`));
    g.append(r);
    g.append(svg('text', { x: x + bw / 2, y: top - 5, class: 'tick', 'text-anchor': 'middle' }, `${c.unit || ''}${num(p.y)}`));
    g.append(svg('text', { x: x + bw / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, p.x.length > 11 ? `${p.x.slice(0, 10)}…` : p.x));
  });
  return g;
}

function scatter(c, pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const px = (v) => L + ((v - x0) * (W - L - R)) / (x1 - x0);
  const py = (v) => T + ((y1 - v) * (H - T - B)) / (y1 - y0);
  const g = frame(c, `${c.title || 'Scatter chart'}: ${pts.length} points`);
  axisY(g, c, Math.min(...ys), Math.max(...ys), py);
  g.append(svg('text', { x: L, y: H - 6, class: 'tick' }, String(num(Math.min(...xs)))));
  g.append(svg('text', { x: W - R, y: H - 6, class: 'tick', 'text-anchor': 'end' }, String(num(Math.max(...xs)))));
  pts.forEach((p, i) => {
    const d = svg('circle', { cx: px(p.x), cy: py(p.y), r: 5, class: 'pt', style: `--i:${i}` });
    d.append(svg('title', {}, `${p.label ? `${p.label}: ` : ''}${p.x}, ${c.unit || ''}${p.y}`));
    g.append(d);
    if (p.label && pts.length <= 12) {
      const left = px(p.x) > W - R - 90; // keep labels clear of the axis ticks
      g.append(svg('text', { x: px(p.x) + (left ? -8 : 8), y: py(p.y) + 4, class: 'tick', 'text-anchor': left ? 'end' : 'start' }, p.label.slice(0, 14)));
    }
  });
  return g;
}

function pie(c, pts, cite) {
  const total = pts.reduce((a, p) => a + Math.max(p.y, 0), 0) || 1;
  const box = html('div', 'pie');
  const g = svg('svg', { viewBox: '-50 -50 100 100', role: 'img', 'aria-label': `${c.title || 'Share'}: ${pts.map((p) => `${p.x} ${p.y}`).join(', ')}` });
  const R0 = 46, R1 = 27;
  let a0 = -Math.PI / 2;
  const legend = html('ul', 'legend');
  pts.forEach((p, i) => {
    const frac = Math.max(p.y, 0) / total, a1 = a0 + frac * 2 * Math.PI, big = frac > 0.5 ? 1 : 0;
    const pt = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
    const d = frac >= 0.999
      ? `M0 ${-R0} A${R0} ${R0} 0 1 1 0 ${R0} A${R0} ${R0} 0 1 1 0 ${-R0} M0 ${-R1} A${R1} ${R1} 0 1 0 0 ${R1} A${R1} ${R1} 0 1 0 0 ${-R1}Z`
      : `M${pt(R0, a0)} A${R0} ${R0} 0 ${big} 1 ${pt(R0, a1)} L${pt(R1, a1)} A${R1} ${R1} 0 ${big} 0 ${pt(R1, a0)}Z`;
    const slice = svg('path', { d, class: `slice s${i % 8}`, 'fill-rule': 'evenodd', style: `--i:${i}` });
    slice.append(svg('title', {}, `${p.x}: ${c.unit || ''}${p.y} (${Math.round(frac * 100)}%)`));
    g.append(slice);
    a0 = a1;
    const li = html('li');
    const sw = html('i', `sw s${i % 8}`);
    const val = html('span', 'val', `${c.unit || ''}${p.y} · ${Math.round(frac * 100)}%`);
    const a = cite(p.src);
    if (a) val.append(' ', a);
    li.append(sw, html('span', 'name', p.x), val);
    legend.append(li);
  });
  box.append(g, legend);
  return box;
}

function bars(c, pts, cite) {
  const max = Math.max(...pts.map((p) => p.y), 0) || 1;
  const list = html('ul', 'bars');
  pts.forEach((p, i) => {
    const li = html('li');
    li.style.setProperty('--i', i);
    const bar = html('span', 'bar');
    bar.style.setProperty('--w', `${Math.max(1, (Math.max(p.y, 0) / max) * 100)}%`);
    const track = html('span', 'lane');
    track.append(bar);
    const val = html('span', 'val', `${c.unit || ''}${p.y}`);
    const a = cite(p.src);
    if (a) val.append(' ', a);
    li.append(html('span', 'name', p.x), track, val);
    list.append(li);
  });
  return list;
}

const NEED = { line: 3, area: 3, scatter: 3, columns: 2, bars: 2, pie: 2 };

export function chartEl(c, sources, play) {
  const root = html('figure', `chart${play ? ' play' : ''}`);
  const bySrc = new Map(sources.map((s) => [s.n, s]));
  const cite = (n) => {
    const s = bySrc.get(n);
    if (!s) return null;
    const a = html('a', 'cite', String(n));
    a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = `${s.title || s.domain} (${s.domain})`;
    return a;
  };
  if (c.title) root.append(html('figcaption', '', c.title));
  if (c.stats?.length) {
    const row = html('dl', 'stats');
    for (const x of c.stats) {
      const d = html('div');
      const dd = html('dd', '', x.value);
      const a = cite(x.src);
      if (a) dd.append(' ', a);
      d.append(html('dt', '', x.label), dd);
      row.append(d);
    }
    root.append(row);
  }
  const pts = c.series ?? [];
  const kind = NEED[c.kind] ? c.kind : 'line';
  if (pts.length >= NEED[kind]) {
    root.append(kind === 'bars' ? bars(c, pts, cite)
      : kind === 'pie' ? pie(c, pts, cite)
      : kind === 'columns' ? columns(c, pts)
      : kind === 'scatter' ? scatter(c, pts)
      : lineOrArea(c, pts, kind === 'area'));
  }
  return root;
}
