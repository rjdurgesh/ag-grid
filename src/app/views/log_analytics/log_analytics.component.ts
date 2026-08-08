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
import { formatDateTime } from '../../shared/date-utils';
import { LogAnalyticsService } from './log_analytics.service';

const PAGE_SIZE_OPTIONS = [100, 1000, 5000, 10000];

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

  readonly selectedFile = signal<string | null>(null);
  readonly fileContent = signal<string>('');
  readonly loadingContent = signal(false);
  /** True while a new page of a large file is being rendered. */
  readonly pageLoading = signal(false);

  // --- pagination -----------------------------------------------------------
  readonly pageSizeOptions = PAGE_SIZE_OPTIONS;
  readonly pageSize = signal(1000);
  readonly currentPage = signal(0);

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
    this.sortedLines().slice(this.pageStart(), this.pageEnd()).join('\n')
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
        this.servers.set(servers);
        if (servers.length) {
          this.selectServer(servers[0].key);
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
    if (this.selectedServerInfo()) {
      this.selectedFile.set(null);
      this.fileContent.set('');
      this.loadFiles();
    }
  }

  private loadFiles(): void {
    const server = this.selectedServerInfo();
    if (!server) {
      return;
    }
    this.loadingFiles.set(true);
    this.svc
      .getFileTree(server)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          // The backend chose the mode; the UI just applies whichever it got.
          if (data.mode === 'lazy') {
            this.fileRoots.set([]);
            this.lazyRoots.set(data.lazyRoots);
          } else {
            this.lazyRoots.set([]);
            this.fileRoots.set(data.roots);
          }
          this.loadingFiles.set(false);
        },
        error: () => {
          this.fileRoots.set([]);
          this.lazyRoots.set([]);
          this.loadingFiles.set(false);
        }
      });
  }

  /**
   * Lazy mode: a folder was expanded for the first time — fetch its immediate
   * children and hand them back to the tree. Errors mark the folder as retryable.
   */
  onFolderLoad(event: { path: string }): void {
    this.svc
      .getDirChildren(this.selectedServer(), event.path)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) =>
          this.filetree()?.applyChildren(event.path, res.entries, res.truncated ? res.total : 0),
        error: () => this.filetree()?.markFolderError(event.path)
      });
  }

  onFileSelect(path: string): void {
    this.selectedFile.set(path);
    this.loadingContent.set(true);
    this.svc
      .getFileContent(this.selectedServer(), path)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (content) => {
          this.fileContent.set(content);
          const total = content ? content.split('\n').length : 0;
          this.pageSize.set(total > 5000 ? 1000 : total < 1000 ? 100 : 1000);
          this.currentPage.set(0);
          this.loadingContent.set(false);
        },
        error: () => {
          this.fileContent.set('Failed to load file content.');
          this.currentPage.set(0);
          this.loadingContent.set(false);
        }
      });
  }

  /** Re-hit the content API for the currently open file. */
  refreshContent(): void {
    const path = this.selectedFile();
    if (path) {
      this.onFileSelect(path);
    }
  }

  /** Flip line order: descending (newest first) ⇄ ascending (oldest first). */
  toggleOrder(): void {
    this.order.update((o) => (o === 'desc' ? 'asc' : 'desc'));
    this.currentPage.set(0);
  }

  /** Download the open file exactly as received. */
  download(): void {
    const path = this.selectedFile();
    if (!path) {
      return;
    }
    const name = path.split(/[\\/]/).pop() ?? 'file.txt';
    const blob = new Blob([this.fileContent()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
      .getFileProperties(this.selectedServer(), path)
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
