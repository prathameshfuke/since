// A small, safe Markdown renderer: everything is escaped first, only a fixed set of tags comes out.
// Citations [n] become links ONLY if n is a source the server really retrieved, and markdown links
// to URLs that were never retrieved render as plain text. The model cannot link to a page it did not read.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** gpt-oss writes citations as 【3†source】. Treat them as [3]. */
export const normalizeCites = (s) => s.replace(/【\s*(\d{1,2})[^】]*】/g, '[$1]');

/** Source numbers actually cited in the text, ascending. */
export function cited(text, sources) {
  const have = new Set(sources.map((s) => s.n));
  const out = new Set();
  for (const m of normalizeCites(text).matchAll(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g)) {
    for (const n of m[1].split(',')) if (have.has(Number(n))) out.add(Number(n));
  }
  return [...out].sort((a, b) => a - b);
}

/** Removes ```changes blocks (the server sends verified rows separately). `pending` = one is still streaming. */
export function splitChanges(text) {
  let rest = text.replace(/```changes[ \t]*\n?[\s\S]*?```/g, '');
  const open = rest.indexOf('```changes');
  if (open === -1) return { text: rest.trimEnd(), pending: false };
  rest = rest.slice(0, open);
  return { text: rest.trimEnd(), pending: true };
}

export function render(text, sources = []) {
  const bySrc = new Map(sources.map((s) => [s.n, s]));
  const urls = new Set(sources.map((s) => s.url));

  const cite = (n) => {
    const s = bySrc.get(Number(n));
    if (!s) return '';
    return `<a class="cite" data-n="${s.n}" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title || s.domain)} (${esc(s.domain)})">${s.n}</a>`;
  };
  const inline = (raw) => {
    let h = esc(raw);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    h = h.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, (m, label, url) =>
      urls.has(url.replace(/&amp;/g, '&')) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : label);
    h = h.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (m, ns) => `<span class="cites">${ns.split(',').map((n) => cite(n.trim())).join('')}</span>`);
    return h;
  };

  const lines = normalizeCites(text).split('\n');
  const out = [];
  const isBlockStart = (l) => /^(```|#{1,4}\s|\s*[-*]\s+|\s*\d+[.)]\s+|>|\s*\|)/.test(l) || /^\s*---+\s*$/.test(l);
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (!ln.trim()) {
      i++;
    } else if (/^#{1,4}\s/.test(ln)) {
      out.push(`<h3>${inline(ln.replace(/^#{1,4}\s+/, ''))}</h3>`);
      i++;
    } else if (/^\s*---+\s*$/.test(ln)) {
      out.push('<hr>');
      i++;
    } else if (/^\s*\|/.test(ln) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(ln);
      i += 2;
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^\s*[-*]\s+/.test(ln) || /^\s*\d+[.)]\s+/.test(ln)) {
      const ordered = /^\s*\d/.test(ln);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
      const items = [];
      for (; i < lines.length && re.test(lines[i]); i++) items.push(lines[i].replace(re, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (/^>/.test(ln)) {
      const buf = [];
      for (; i < lines.length && /^>/.test(lines[i]); i++) buf.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    } else {
      const buf = [];
      for (; i < lines.length && lines[i].trim() && (buf.length === 0 || !isBlockStart(lines[i])); i++) buf.push(lines[i].trim());
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}
