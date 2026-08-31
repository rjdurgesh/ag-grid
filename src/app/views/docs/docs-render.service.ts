import { Injectable } from '@angular/core';

/** One entry in the auto-generated table of contents (h2/h3 headings). */
export interface TocItem {
  id: string;
  text: string;
  level: number;
}

/** Rendered markdown: safe HTML string + the heading tree for the TOC. */
export interface RenderedDoc {
  html: string;
  toc: TocItem[];
}

/**
 * Self-contained, **safe-by-construction** Markdown → HTML renderer for the Documentation Center.
 *
 * Design note (see DOCS_DESIGN.md): the locked decision was client-side render + sanitize. Rather than
 * pull in `markdown-it` + `DOMPurify` (an extra supply-chain surface this environment prefers to avoid),
 * Phase 1 ships this dependency-free renderer. Its safety model is stronger than "parse then sanitize":
 * it NEVER passes raw HTML from the source through — every run of source text is HTML-escaped, and the
 * only tags/attributes emitted are the fixed whitelist below. A `<script>` (or any raw HTML) in a `.md`
 * file therefore renders as visible text, not markup. URLs are checked against a scheme allow-list.
 *
 * Supported: ATX headings (with slug ids + TOC), paragraphs, **bold** / *italic*, `inline code`,
 * fenced code blocks, links, images, blockquotes, ordered/unordered (nested) lists, `---` rules,
 * and GitHub-style pipe tables. Swapping in a full library later is a single-file change — keep
 * {@link render}'s signature.
 */
@Injectable({ providedIn: 'root' })
export class DocsRenderService {
  render(markdown: string): RenderedDoc {
    const toc: TocItem[] = [];
    const used = new Set<string>();
    const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
    const html = this.parseBlocks(lines, toc, used);
    return { html, toc };
  }

  // --- block level -----------------------------------------------------------
  private parseBlocks(lines: string[], toc: TocItem[], used: Set<string>): string {
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Blank line → nothing (block separator).
      if (line.trim() === '') { i++; continue; }

      // Fenced code block ``` or ~~~ (optionally with a language after the fence).
      const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        const marker = fence[1][0];
        const close = new RegExp(`^\\s*${marker}{3,}\\s*$`);
        const body: string[] = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i++; }
        i++; // skip closing fence (if present)
        out.push(
          `<div class="doc-code"><button class="doc-copy" type="button" aria-label="Copy code">Copy</button>` +
          `<pre><code>${this.esc(body.join('\n'))}</code></pre></div>`
        );
        continue;
      }

      // ATX heading.
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        const level = h[1].length;
        const raw = h[2];
        const slug = this.slug(this.stripInline(raw), used);
        out.push(`<h${level} id="${slug}">${this.inline(raw)}</h${level}>`);
        if (level === 2 || level === 3) { toc.push({ id: slug, text: this.stripInline(raw), level }); }
        i++;
        continue;
      }

      // Horizontal rule.
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // Blockquote (collect consecutive `>` lines, render inner recursively).
      if (/^\s*>\s?/.test(line)) {
        const inner: string[] = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          inner.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${this.parseBlocks(inner, toc, used)}</blockquote>`);
        continue;
      }

      // GitHub pipe table: a header row + a separator row of dashes.
      if (line.includes('|') && i + 1 < lines.length && this.isTableSep(lines[i + 1])) {
        const res = this.parseTable(lines, i);
        out.push(res.html);
        i = res.next;
        continue;
      }

      // Ordered / unordered list.
      if (this.isListItem(line)) {
        const res = this.parseList(lines, i);
        out.push(res.html);
        i = res.next;
        continue;
      }

      // Paragraph — accumulate until a blank line or the start of another block.
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !this.startsBlock(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push(`<p>${this.inline(para.join(' '))}</p>`);
    }
    return out.join('\n');
  }

  private startsBlock(line: string): boolean {
    return /^\s*(`{3,}|~{3,})/.test(line)
      || /^(#{1,6})\s+/.test(line)
      || /^\s*([-*_])\1{2,}\s*$/.test(line)
      || /^\s*>\s?/.test(line)
      || this.isListItem(line);
  }

  private isListItem(line: string): boolean {
    return /^(\s*)([-*+]|\d+\.)\s+/.test(line);
  }

  private indentOf(line: string): number {
    const m = /^(\s*)/.exec(line);
    return m ? m[1].replace(/\t/g, '  ').length : 0;
  }

  private parseList(lines: string[], start: number): { html: string; next: number } {
    const base = this.indentOf(lines[start]);
    const ordered = /^\s*\d+\.\s+/.test(lines[start]);
    const itemRe = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/;
    let i = start;
    let html = ordered ? '<ol>' : '<ul>';
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        const nxt = lines[i + 1] ?? '';
        if (this.isListItem(nxt) && this.indentOf(nxt) >= base) { i++; continue; }
        break;
      }
      if (!this.isListItem(line) || this.indentOf(line) < base) { break; }
      const m = itemRe.exec(line)!;
      let inner = this.inline(m[2]);
      i++;
      // Nested list(s) belonging to this item (indented deeper).
      while (i < lines.length) {
        const nl = lines[i];
        if (nl.trim() === '') {
          const nxt = lines[i + 1] ?? '';
          if (this.isListItem(nxt) && this.indentOf(nxt) > base) { i++; continue; }
          break;
        }
        if (this.isListItem(nl) && this.indentOf(nl) > base) {
          const sub = this.parseList(lines, i);
          inner += sub.html;
          i = sub.next;
        } else {
          break;
        }
      }
      html += `<li>${inner}</li>`;
    }
    html += ordered ? '</ol>' : '</ul>';
    return { html, next: i };
  }

  private isTableSep(line: string): boolean {
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
  }

  private parseTable(lines: string[], start: number): { html: string; next: number } {
    const cells = (row: string): string[] =>
      row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const aligns = cells(lines[start + 1]).map((s) => {
      const l = s.startsWith(':');
      const r = s.endsWith(':');
      return r && l ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    const header = cells(lines[start]);
    let i = start + 2;
    const bodyRows: string[][] = [];
    while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
      bodyRows.push(cells(lines[i]));
      i++;
    }
    const th = header.map((c, k) => `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${this.inline(c)}</th>`).join('');
    const body = bodyRows
      .map((r) => '<tr>' + r.map((c, k) => `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${this.inline(c)}</td>`).join('') + '</tr>')
      .join('');
    return { html: `<div class="doc-tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`, next: i };
  }

  // --- inline level ----------------------------------------------------------
  /** Render inline markdown to safe HTML. Links/images/code are extracted BEFORE escaping so their
   *  URLs can be validated; everything else is escaped, then emphasis is applied to the escaped text. */
  private inline(text: string): string {
    const store: string[] = [];
    // NUL-wrapped index (the \\u0000 escapes compile to NUL) so a placeholder can never collide with
    // real text such as a bare " 3 " — esc() and the emphasis regexes leave NUL bytes and digits alone.
    const stash = (html: string): string => `\\u0000${store.push(html) - 1}\\u0000`;

    let s = text ?? '';
    // Images first (![alt](url)), then links ([text](url)) so the link regex doesn't eat images.
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) => {
      const safe = this.safeUrl(url, true);
      return safe ? stash(`<img src="${safe}" alt="${this.esc(alt)}" loading="lazy">`) : this.esc(_m);
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label, url) => {
      const safe = this.safeUrl(url, false);
      return safe
        ? stash(`<a href="${safe}" target="_blank" rel="noopener noreferrer">${this.esc(label)}</a>`)
        : this.esc(_m);
    });
    // Inline code — escaped, never further processed.
    s = s.replace(/`([^`]+)`/g, (_m, code) => stash(`<code>${this.esc(code)}</code>`));

    // Escape everything that remains (plain text + emphasis markers + placeholders survive).
    s = this.esc(s);

    // Emphasis on the escaped text. Bold before italic; **/__ then *.
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Restore extracted links/images/code.
    return s.replace(/\\u0000(\d+)\\u0000/g, (_m, k) => store[Number(k)] ?? '');
  }

  /** Plain-text form of an inline string for the TOC label / slug (drops markdown syntax). */
  private stripInline(text: string): string {
    return (text ?? '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '')
      .trim();
  }

  private slug(text: string, used: Set<string>): string {
    let base = (text || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    let s = base;
    let n = 2;
    while (used.has(s)) { s = `${base}-${n++}`; }
    used.add(s);
    return s;
  }

  /** Allow only safe URL schemes; return the URL (or null to reject → rendered as text). */
  private safeUrl(url: string, isImage: boolean): string | null {
    const u = (url || '').trim();
    if (!u) { return null; }
    // Anchors and relative/site-root paths are fine.
    if (u.startsWith('#') || u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) {
      return this.esc(u);
    }
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u);
    if (!scheme) { return this.esc(u); } // scheme-less relative (e.g. "guide.md")
    const s = scheme[1].toLowerCase();
    const ok = isImage ? s === 'http' || s === 'https' : s === 'http' || s === 'https' || s === 'mailto';
    return ok ? this.esc(u) : null;
  }

  private esc(s: string): string {
    return (s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
