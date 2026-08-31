import { Component, DestroyRef, computed, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';

import { LoaderComponent } from '../../components/loader/loader.component';
import { DocAudience, DocEntry } from '../../shared/models';
import { DocsService } from './docs.service';
import { DocsRenderService, TocItem } from './docs-render.service';

/** One rendered catalogue section (Guides / Wikis & Runbooks) within a single guide. */
interface DocSection {
  key: string;
  title: string;
  hint: string;
  entries: DocEntry[];
}

/**
 * Reusable Documentation **browser** — the catalogue + in-app reader engine, scoped to ONE audience
 * via the `audience` input. It is not a screen itself; each guide screen (User Guide / Technical Guide)
 * is its own component that simply renders this with the right audience. That keeps the two screens
 * separate and independently evolvable while the reader/markdown logic lives in one place.
 *
 * Two views in one: the card catalogue, and — when a markdown doc is opened — the reader (a `selected`
 * signal toggles them). Wiki entries are plain external links; only markdown entries enter the reader.
 */
@Component({
  selector: 'app-docs-browser',
  templateUrl: './docs-browser.component.html',
  styleUrls: ['./docs-browser.component.scss'],
  imports: [NgTemplateOutlet, LoaderComponent]
})
export class DocsBrowserComponent implements OnInit {
  private readonly docs = inject(DocsService);
  private readonly renderer = inject(DocsRenderService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** Which guide this browser shows (set by the owning screen component). */
  readonly audience = input.required<DocAudience>();

  // --- catalogue state -------------------------------------------------------
  readonly loading = signal(true);
  readonly error = signal('');
  readonly entries = signal<DocEntry[]>([]);
  readonly search = signal('');

  readonly heroTitle = computed(() => (this.audience() === 'technical' ? 'Technical Guide' : 'User Guide'));
  readonly heroSub = computed(() =>
    this.audience() === 'technical'
      ? 'Design docs, internals, runbooks and technical references.'
      : 'Guides, how-tos and references for everyday use.');

  // --- reader state ----------------------------------------------------------
  readonly selected = signal<DocEntry | null>(null);
  readonly docLoading = signal(false);
  readonly docHtml = signal<SafeHtml>('');
  readonly toc = signal<TocItem[]>([]);
  readonly docUpdated = signal('');
  private rawMarkdown = '';
  /** The `?doc=` id we should be showing (from the URL); reconciled against the loaded catalogue. */
  private pendingId: string | null = null;

  /** Entries belonging to this guide's audience (both wiki links and markdown files). */
  private readonly audienceEntries = computed(() => this.entries().filter((e) => e.audience === this.audience()));

  /** …narrowed by the search box (title / description / tags). */
  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const all = this.audienceEntries();
    if (!q) {
      return all;
    }
    return all.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });

  /** Two sub-sections within the guide: in-app markdown Guides + external Wikis & Runbooks. */
  readonly sections = computed<DocSection[]>(() => {
    const list = this.filtered();
    return [
      { key: 'guides', title: 'Guides', hint: 'In-app documents',
        entries: list.filter((e) => e.type === 'markdown') },
      { key: 'wikis', title: 'Wikis & Runbooks', hint: 'External links — open in a new tab',
        entries: list.filter((e) => e.type === 'wiki') }
    ].filter((s) => s.entries.length > 0);
  });

  readonly isEmpty = computed(() => !this.loading() && this.audienceEntries().length === 0);
  readonly noMatches = computed(() => !this.loading() && this.audienceEntries().length > 0 && this.filtered().length === 0);

  ngOnInit(): void {
    this.load();
    // The open document is URL state (?doc=<id>) so the browser Back button returns to THIS guide's
    // catalogue (not the previous page), and doc links are shareable/bookmarkable.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((pm) => {
      this.pendingId = pm.get('doc');
      this.syncReader();
    });
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.docs
      .catalog()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => {
          this.entries.set(list ?? []);
          this.loading.set(false);
          this.syncReader();           // a deep-link (?doc=…) can now resolve against the catalogue
        },
        error: () => {
          this.error.set('Could not load the documentation catalogue.');
          this.entries.set([]);
          this.loading.set(false);
        }
      });
  }

  /** Card click — open a markdown doc by pushing ?doc=<id>. (Wikis are external `<a>` links.) */
  open(entry: DocEntry): void {
    if (entry.type !== 'markdown') {
      return;
    }
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { doc: entry.id },
      queryParamsHandling: 'merge'
    });
  }

  /** In-page Back — drops ?doc= and returns to this guide's catalogue. */
  back(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { doc: null },
      queryParamsHandling: 'merge'
    });
  }

  /** Reconcile the reader with the current ?doc= param + loaded catalogue. */
  private syncReader(): void {
    const id = this.pendingId;
    if (!id) {
      this.clearReader();
      return;
    }
    const entry = this.entries().find((e) => e.id === id) ?? null;
    if (!entry) {
      return;                          // catalogue not loaded yet — retry after load()
    }
    if (entry.type !== 'markdown') {
      this.clearReader();
      return;
    }
    if (this.selected()?.id === entry.id && !!this.docHtml()) {
      return;                          // already open
    }
    this.selected.set(entry);
    this.fetchContent(entry);
  }

  private clearReader(): void {
    this.selected.set(null);
    this.rawMarkdown = '';
    this.docHtml.set('');
    this.toc.set([]);
  }

  private fetchContent(entry: DocEntry): void {
    this.docLoading.set(true);
    this.docHtml.set('');
    this.toc.set([]);
    this.error.set('');
    this.docs
      .content(entry.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (doc) => {
          this.rawMarkdown = doc.markdown ?? '';
          const r = this.renderer.render(this.rawMarkdown);
          // bypass is safe: DocsRenderService escapes ALL source text and emits only a fixed tag
          // whitelist (no raw HTML passthrough), so there is nothing for the sanitizer to strip.
          this.docHtml.set(this.sanitizer.bypassSecurityTrustHtml(r.html));
          this.toc.set(r.toc);
          this.docUpdated.set(doc.updated ?? entry.updated ?? '');
          this.docLoading.set(false);
        },
        error: () => {
          this.error.set('Could not load this document.');
          this.docLoading.set(false);
        }
      });
  }

  badge(entry: DocEntry): string {
    return entry.type === 'wiki' ? 'Wiki' : 'Doc';
  }

  /** The small mono line under a card title: the filename for a doc, the host for a wiki. */
  cardSource(entry: DocEntry): string {
    if (entry.file) {
      return entry.file;
    }
    if (entry.type === 'wiki' && entry.url) {
      try {
        return new URL(entry.url).hostname.replace(/^www\./, '');
      } catch {
        return entry.url;
      }
    }
    return '';
  }

  /** Scroll a heading into view from the TOC (honours reduced-motion). */
  goto(id: string): void {
    const el = document.getElementById(id);
    if (!el) {
      return;
    }
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  /** Copy a code block — event delegation on the rendered article (no per-button binding). */
  onReaderClick(ev: MouseEvent): void {
    const btn = (ev.target as HTMLElement)?.closest?.('.doc-copy') as HTMLElement | null;
    if (!btn) {
      return;
    }
    const code = btn.parentElement?.querySelector('pre code')?.textContent ?? '';
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('is-copied');
        setTimeout(() => {
          btn.textContent = prev;
          btn.classList.remove('is-copied');
        }, 1400);
      })
      .catch(() => {
        /* clipboard unavailable — ignore */
      });
  }

  /** Download the raw markdown (client-side blob — no backend endpoint needed). */
  downloadRaw(): void {
    const entry = this.selected();
    if (!entry) {
      return;
    }
    const blob = new Blob([this.rawMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${entry.id}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
