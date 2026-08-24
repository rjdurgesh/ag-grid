import { DecimalPipe } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import {
  ButtonCloseDirective,
  ButtonDirective,
  DropdownComponent,
  DropdownItemDirective,
  DropdownMenuDirective,
  DropdownToggleDirective,
  ModalBodyComponent,
  ModalComponent,
  ModalFooterComponent,
  ModalHeaderComponent,
  ModalTitleDirective
} from '@coreui/angular';

import { FiletreeComponent, LazyRoot, TreeRoot } from '../../components/filetree/filetree.component';
import { LoaderComponent } from '../../components/loader/loader.component';
import { FileProperties, LogServer } from '../../shared/models';
import { RbacService } from '../../auth/rbac.service';
import { formatDateTime } from '../../shared/date-utils';
import { FileWindowOpts, LogAnalyticsService } from './log_analytics.service';

const PAGE_SIZE_OPTIONS = [100, 1000, 5000, 10000];

/** Byte-window sizes for the large-file pager (one window = one page). */
const WINDOW_SIZE_OPTIONS = [
  { label: '256 KB', bytes: 256 * 1024 },
  { label: '512 KB', bytes: 512 * 1024 },
  { label: '1 MB', bytes: 1024 * 1024 },
  { label: '2 MB', bytes: 2 * 1024 * 1024 },
  { label: '5 MB', bytes: 5 * 1024 * 1024 }
];

/** Forward-slash form, trailing slash stripped — matches how paths travel to the API. */
const norm = (s: string): string => (s ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Log Analytics Hub — pick a server (list + file paths both from the API) and
 * browse its logs as a file tree, previewing file content with pagination for
 * large files.
 */
@Component({
  selector: 'app-log-analytics',
  templateUrl: './log_analytics.component.html',
  styleUrls: ['./log_analytics.component.scss'],
  imports: [
    FiletreeComponent,
    LoaderComponent,
    DecimalPipe,
    DropdownComponent,
    DropdownToggleDirective,
    DropdownMenuDirective,
    DropdownItemDirective,
    ModalComponent,
    ModalHeaderComponent,
    ModalTitleDirective,
    ModalBodyComponent,
    ModalFooterComponent,
    ButtonDirective,
    ButtonCloseDirective
  ]
})
export class LogAnalyticsComponent implements OnInit {
  private readonly svc = inject(LogAnalyticsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly rbac = inject(RbacService);
  /** Reference to the tree so we can hand lazily-loaded folder children back. */
  private readonly filetree = viewChild(FiletreeComponent);

  readonly servers = signal<LogServer[]>([]);
  /** The composite key of the selected server (map key from the API). */
  readonly selectedServer = signal<string>('');
  /** Full mode: one tree root per configured base path, each with its files. */
  readonly fileRoots = signal<TreeRoot[]>([]);
  /** Lazy mode: root folders only; children fetched on expand. */
  readonly lazyRoots = signal<LazyRoot[]>([]);
  readonly loadingFiles = signal(false);
  /** True while a left-panel refresh re-fetches open folders (spins the button; keeps the tree visible). */
  readonly refreshing = signal(false);

  readonly selectedFile = signal<string | null>(null);
  readonly fileContent = signal<string>('');
  readonly loadingContent = signal(false);
  /** True while a new page of a large file is being rendered. */
  readonly pageLoading = signal(false);

  // --- pagination (full mode) -----------------------------------------------
  readonly pageSizeOptions = PAGE_SIZE_OPTIONS;
  readonly pageSize = signal(1000);
  readonly currentPage = signal(0);

  // --- large-file windowing (window mode) -----------------------------------
  /** 'full' = whole file loaded (line pager); 'window' = paging a huge file by byte window. */
  readonly fileMode = signal<'full' | 'window'>('full');
  readonly windowSizeOptions = WINDOW_SIZE_OPTIONS;
  readonly windowBytes = signal(WINDOW_SIZE_OPTIONS[2].bytes); // default 1 MB
  /** Current window's byte range, the file's total size, and edge flags. */
  readonly winStart = signal(0);
  readonly winEnd = signal(0);
  readonly totalSize = signal(0);
  readonly atBof = signal(true);
  readonly atEof = signal(true);

  /** 1-based page number in READING order (page 1 = the first window shown). */
  readonly windowPage = signal(1);
  /** Approx total windows — line-aligned windows run a touch under `windowBytes`, so it's a hint. */
  readonly windowTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.totalSize() / this.windowBytes()))
  );
  /** Page 1 (reading order) is the tail in desc (newest-first), the head in asc. */
  readonly atFirstPage = computed(() => (this.order() === 'desc' ? this.atEof() : this.atBof()));
  readonly atLastPage = computed(() => (this.order() === 'desc' ? this.atBof() : this.atEof()));

  /**
   * Line order: `desc` = newest / last line first (default — logs read best
   * newest-first), `asc` = oldest / first line first (natural file order).
   */
  readonly order = signal<'asc' | 'desc'>('desc');

  readonly lines = computed(() => (this.fileContent() ? this.fileContent().split('\n') : []));

  private readonly sortedLines = computed(() => {
    const lines = this.lines();
    return this.order() === 'desc' ? [...lines].reverse() : lines;
  });

  readonly totalLines = computed(() => this.lines().length);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalLines() / this.pageSize())));
  readonly pageStart = computed(() => this.currentPage() * this.pageSize());
  readonly pageEnd = computed(() => Math.min(this.pageStart() + this.pageSize(), this.totalLines()));
  readonly pageText = computed(() =>
    this.fileMode() === 'window'
      ? this.sortedLines().join('\n') // window mode: render the whole (bounded) window
      : this.sortedLines().slice(this.pageStart(), this.pageEnd()).join('\n')
  );

  /** Human-readable label for the current window's byte range, e.g. "12.0–13.0 MB of 1.8 GB". */
  readonly windowRangeLabel = computed(
    () => `${this.formatBytes(this.winStart())}–${this.formatBytes(this.winEnd())} of ${this.formatBytes(this.totalSize())}`
  );

  /** The full record for the currently selected server. */
  readonly selectedServerInfo = computed(() => {
    const key = this.selectedServer();
    return this.servers().find((s) => s.key === key) ?? null;
  });

  /** Label for the currently selected server, shown in the footer. */
  readonly selectedServerLabel = computed(() => this.selectedServerInfo()?.serverName ?? this.selectedServer());

  // --- properties dialog ----------------------------------------------------
  readonly propertiesVisible = signal(false);
  readonly propertiesLoading = signal(false);
  readonly properties = signal<FileProperties | null>(null);

  ngOnInit(): void {
    this.svc
      .getServers()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((servers) => {
        // RBAC opt-in: a user sees only the servers granted to them (ADMIN / all_servers see all).
        const allowed = servers.filter((s) => this.rbac.serverAllowed(s.serverName));
        this.servers.set(allowed);
        if (allowed.length) {
          this.selectServer(allowed[0].key);
        }
      });
  }

  onServerChange(event: Event): void {
    this.selectServer((event.target as HTMLSelectElement).value);
  }

  private selectServer(key: string): void {
    this.selectedServer.set(key);
    this.selectedFile.set(null);
    this.fileContent.set('');
    this.fileMode.set('full');
    this.fileRoots.set([]);
    this.lazyRoots.set([]);
    this.loadFiles();
  }

  /**
   * Left refresh button — reload the SELECTED server's tree (re-fetch its base
   * paths' content) and reset the right preview to default, so a refresh never
   * leaves the last-read file showing. (Does not re-hit /servers — that only
   * happens on page open/refresh.)
   */
  refreshFiles(): void {
    const server = this.selectedServerInfo();
    if (!server) {
      return;
    }
    // Reset the right preview to default (as before).
    this.selectedFile.set(null);
    this.fileContent.set('');

    // Keep the tree OPEN: re-fetch every currently-expanded folder and merge the
    // fresh listing in place (new files/dirs appear, deleted ones drop, open
    // sub-folders stay open). If nothing is expanded, just re-seed the roots.
    const open = this.filetree()?.expandedPaths() ?? [];
    if (!open.length) {
      this.loadFiles();
      return;
    }
    this.refreshing.set(true);
    let pending = open.length;
    const done = (): void => {
      if (--pending <= 0) {
        this.refreshing.set(false);
      }
    };
    for (const path of open) {
      this.svc
        .getDirChildren(this.selectedServer(), this.ownerBase(path), path)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) =>
            this.filetree()?.applyChildren(path, res.entries, res.truncated ? res.total : 0),
          error: () => done(),
          complete: () => done()
        });
    }
  }

  private loadFiles(): void {
    const server = this.selectedServerInfo();
    if (!server) {
      return;
    }
    // The dropdown already carries the server's base paths (from /servers) — seed
    // the tree straight from them, one lazy root per base. Each folder's children
    // load on first expand via /dir. No extra API call needed here.
    this.fileRoots.set([]);
    this.lazyRoots.set(server.basePaths.filter(Boolean).map((p) => ({ label: p, path: norm(p) })));
    this.loadingFiles.set(false);
  }

  /**
   * The server `base_log_path` that owns `path` (longest matching prefix). The UI
   * sends this back to the backend as `base` so it can confine browsing to that
   * base without another DB call. Falls back to the first base if none matches.
   */
  private ownerBase(path: string): string {
    const p = norm(path).toLowerCase();
    const bases = this.selectedServerInfo()?.basePaths ?? [];
    return (
      bases.find((b) => {
        const bl = norm(b).toLowerCase();
        return p === bl || p.startsWith(bl + '/');
      }) ??
      bases[0] ??
      ''
    );
  }

  /**
   * Lazy mode: a folder was expanded for the first time — fetch its immediate
   * children and hand them back to the tree. Errors mark the folder as retryable.
   */
  onFolderLoad(event: { path: string }): void {
    this.svc
      .getDirChildren(this.selectedServer(), this.ownerBase(event.path), event.path)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) =>
          this.filetree()?.applyChildren(event.path, res.entries, res.truncated ? res.total : 0),
        error: () => this.filetree()?.markFolderError(event.path)
      });
  }

  onFileSelect(path: string): void {
    this.selectedFile.set(path);
    this.windowPage.set(1);
    // Page 1 = the first window in reading order (newest-first → the tail; oldest-first
    // → the head). Small files come back whole ('full') and use the line pager; large
    // files come back as one WINDOW ('window'), so a multi-GB file never loads whole.
    this.fetchFile(path, this.pageOneOpts());
  }

  /** The window request for "page 1", given the current sort order. */
  private pageOneOpts(): FileWindowOpts {
    return this.order() === 'desc'
      ? { fromEnd: true, length: this.windowBytes() }
      : { offset: 0, length: this.windowBytes() };
  }

  /**
   * Load a file — or one window of it — into the preview. `opts` targets a window
   * for large files; small files ignore it and come back whole.
   */
  private fetchFile(path: string, opts: FileWindowOpts): void {
    this.loadingContent.set(true);
    this.svc
      .getFile(this.selectedServer(), this.ownerBase(path), path, opts)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.fileContent.set(res.content);
          this.currentPage.set(0);
          this.totalSize.set(res.total_size);
          if (res.mode === 'window') {
            this.fileMode.set('window');
            this.winStart.set(res.start);
            this.winEnd.set(res.end);
            this.atBof.set(res.bof);
            this.atEof.set(res.eof);
          } else {
            this.fileMode.set('full');
            const total = res.content ? res.content.split('\n').length : 0;
            this.pageSize.set(total > 5000 ? 1000 : total < 1000 ? 100 : 1000);
          }
          this.loadingContent.set(false);
        },
        error: (err) => {
          // A file deleted after the tree loaded still shows as a node; the backend
          // answers 404 (never hangs). Say so plainly and hint at the tree refresh.
          const gone = (err as { status?: number })?.status === 404;
          this.fileMode.set('full');
          this.fileContent.set(
            gone
              ? 'This file no longer exists on the server. Use the refresh button to update the tree.'
              : 'Failed to load file content.'
          );
          this.currentPage.set(0);
          this.loadingContent.set(false);
        }
      });
  }

  /** Re-hit the content API for the currently open file (same position). */
  refreshContent(): void {
    const path = this.selectedFile();
    if (!path) {
      return;
    }
    this.fileMode() === 'window'
      ? this.fetchFile(path, { offset: this.winStart(), length: this.windowBytes() })
      : this.fetchFile(path, { fromEnd: this.order() === 'desc', length: this.windowBytes() });
  }

  // --- large-file window navigation (in READING order, like the line pager) ---
  /** First page — the newest window in desc, the oldest in asc. */
  pageFirst(): void {
    const p = this.selectedFile();
    if (p) {
      this.windowPage.set(1);
      this.fetchFile(p, this.pageOneOpts());
    }
  }
  /** Next page — read further along (older in desc, later in asc). */
  pageNext(): void {
    const p = this.selectedFile();
    if (!p || this.atLastPage()) {
      return;
    }
    this.windowPage.update((n) => n + 1);
    this.fetchFile(
      p,
      this.order() === 'desc'
        ? { offset: Math.max(0, this.winStart() - this.windowBytes()), length: this.windowBytes() }
        : { offset: this.winEnd(), length: this.windowBytes() }
    );
  }
  /** Previous page — back toward page 1 (newer in desc, earlier in asc). */
  pagePrev(): void {
    const p = this.selectedFile();
    if (!p || this.atFirstPage()) {
      return;
    }
    this.windowPage.update((n) => Math.max(1, n - 1));
    this.fetchFile(
      p,
      this.order() === 'desc'
        ? { offset: this.winEnd(), length: this.windowBytes() }
        : { offset: Math.max(0, this.winStart() - this.windowBytes()), length: this.windowBytes() }
    );
  }
  /** Last page — the oldest window in desc, the newest in asc. */
  pageLast(): void {
    const p = this.selectedFile();
    if (p) {
      this.windowPage.set(this.windowTotalPages());
      this.fetchFile(
        p,
        this.order() === 'desc'
          ? { offset: 0, length: this.windowBytes() }
          : { fromEnd: true, length: this.windowBytes() }
      );
    }
  }
  /** Window-size change — reload from page 1 at the new size (like items-per-page). */
  onWindowSizeChange(event: Event): void {
    this.windowBytes.set(Number((event.target as HTMLSelectElement).value));
    this.pageFirst();
  }

  /**
   * Flip line order: descending (newest first) ⇄ ascending (oldest first). In
   * window mode "page 1" flips to the other end of the file, so reload it to keep
   * the pager consistent.
   */
  toggleOrder(): void {
    this.order.update((o) => (o === 'desc' ? 'asc' : 'desc'));
    this.currentPage.set(0);
    if (this.fileMode() === 'window') {
      this.pageFirst();
    }
  }

  /**
   * Download the WHOLE file — streamed straight from the backend to disk (works at
   * any size; the preview may only hold one window). The server sets the filename
   * via Content-Disposition, so a plain anchor to the URL triggers the download.
   */
  download(): void {
    const path = this.selectedFile();
    if (!path) {
      return;
    }
    const a = document.createElement('a');
    a.href = this.svc.downloadUrl(this.ownerBase(path), path);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  openProperties(): void {
    const path = this.selectedFile();
    if (!path) {
      return;
    }
    this.properties.set(null);
    this.propertiesLoading.set(true);
    this.propertiesVisible.set(true);
    this.svc
      .getFileProperties(this.selectedServer(), this.ownerBase(path), path)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (props) => {
          this.properties.set(props);
          this.propertiesLoading.set(false);
        },
        error: () => this.propertiesLoading.set(false)
      });
  }

  onPropertiesVisibleChange(open: boolean): void {
    this.propertiesVisible.set(open);
  }

  closeProperties(): void {
    this.propertiesVisible.set(false);
  }

  /** Format an ISO timestamp for the Properties dialog. */
  formatStamp(value: string): string {
    return formatDateTime(value);
  }

  /** Human-readable byte size, e.g. "1.4 MB (1,468,006 bytes)". */
  formatSize(bytes: number): string {
    const units = ['bytes', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    const pretty = unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
    return unit === 0 ? pretty : `${pretty} (${bytes.toLocaleString()} bytes)`;
  }

  /** Compact byte size for the window pager, e.g. "12.0 MB" / "1.8 GB". */
  formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
  }

  onPageSizeChange(event: Event): void {
    const size = Number((event.target as HTMLSelectElement).value);
    this.withPageLoading(() => {
      this.pageSize.set(size);
      this.currentPage.set(0);
    });
  }

  prevPage(): void {
    this.withPageLoading(() => this.currentPage.update((p) => Math.max(0, p - 1)));
  }

  nextPage(): void {
    this.withPageLoading(() => this.currentPage.update((p) => Math.min(this.totalPages() - 1, p + 1)));
  }

  /**
   * Slicing + painting thousands of lines blocks a frame, so surface a loader
   * while the new page renders instead of letting the UI appear frozen.
   */
  private withPageLoading(apply: () => void): void {
    this.pageLoading.set(true);
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(() => this.pageLoading.set(false));
    });
  }
}
