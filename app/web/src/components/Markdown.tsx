import { useMemo } from 'react';

/**
 * A small, dependency-free markdown renderer.
 *
 * Deliberately not a library: the corpus is a project's own docs, and the only
 * feature that genuinely matters here is that a RELATIVE LINK NAVIGATES INSIDE
 * THE BROWSER rather than leaving it. Everything else is headings, lists,
 * tables, code and emphasis.
 */
export function Markdown({ src, onNavigate }: { src: string; onNavigate: (href: string) => void }) {
  const html = useMemo(() => render(src), [src]);
  return (
    <div
      className="prose-doc"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a[data-rel]');
        if (!a) return;
        e.preventDefault();
        onNavigate(a.getAttribute('data-rel')!);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function inline(t: string): string {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt: string, href: string) =>
      /^https?:/.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${txt}</a>`
        : `<a href="#" data-rel="${esc(href)}">${txt}</a>`);
}

function render(src: string): string {
  const out: string[] = [];
  let inCode = false, inList = false, inTable = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  for (const raw of src.split('\n')) {
    if (raw.startsWith('```')) {
      closeList(); closeTable();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(raw) + '\n'); continue; }

    if (raw.trimStart().startsWith('|') && raw.includes('|')) {
      if (/^[\s|:-]+$/.test(raw)) continue;
      const cells = raw.split('|').slice(1, -1);
      if (!inTable) { closeList(); out.push('<table><tbody>'); inTable = true; }
      out.push('<tr>' + cells.map((c) => `<td>${inline(c.trim())}</td>`).join('') + '</tr>');
      continue;
    }
    closeTable();

    const li = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1]!)}</li>`);
      continue;
    }
    closeList();

    const h = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (h) { const n = h[1]!.length; out.push(`<h${n}>${inline(h[2]!)}</h${n}>`); continue; }
    if (raw.trim()) out.push(`<p>${inline(raw)}</p>`);
  }
  closeList(); closeTable();
  if (inCode) out.push('</code></pre>');
  return out.join('');
}
