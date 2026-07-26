import { DecimalPipe } from '@angular/common';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
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

import { FiletreeComponent } from '../../components/filetree/filetree.component';
import { LoaderComponent } from '../../components/loader/loader.component';
import { FileProperties, ServerInfo } from '../../shared/models';
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

  readonly servers = signal<ServerInfo[]>([]);
  readonly selectedServer = signal<string>('');
  readonly paths = signal<string[]>([]);
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

  /** Content sort: natural file order, or lines sorted A→Z / Z→A. */
  readonly sortDir = signal<'none' | 'asc' | 'desc'>('none');

  readonly lines = computed(() => (this.fileContent() ? this.fileContent().split('\n') : []));

  private readonly sortedLines = computed(() => {
    const dir = this.sortDir();
    const all = this.lines();
    if (dir === 'none') {
      return all;
    }
    const sorted = [...all].sort((a, b) => a.localeCompare(b));
    return dir === 'asc' ? sorted : sorted.reverse();
  });

  readonly totalLines = computed(() => this.lines().length);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalLines() / this.pageSize())));
  readonly pageStart = computed(() => this.currentPage() * this.pageSize());
  readonly pageEnd = computed(() => Math.min(this.pageStart() + this.pageSize(), this.totalLines()));
  readonly pageText = computed(() =>
    this.sortedLines().slice(this.pageStart(), this.pageEnd()).join('\n')
  );

  /** Label for the currently selected server, shown in the footer. */
  readonly selectedServerLabel = computed(() => {
    const id = this.selectedServer();
    return this.servers().find((s) => s.id === id)?.name ?? id;
  });

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
          this.selectServer(servers[0].id);
        }
      });
  }

  onServerChange(event: Event): void {
    this.selectServer((event.target as HTMLSelectElement).value);
  }

  private selectServer(id: string): void {
    this.selectedServer.set(id);
    this.selectedFile.set(null);
    this.fileContent.set('');
    this.loadFiles(id);
  }

  /** Re-hit the files API for the current server and rebuild the tree. */
  refreshFiles(): void {
    if (this.selectedServer()) {
      this.loadFiles(this.selectedServer());
    }
  }

  private loadFiles(id: string): void {
    this.loadingFiles.set(true);
    this.svc
      .getFiles(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (paths) => {
          this.paths.set(paths);
          this.loadingFiles.set(false);
        },
        error: () => {
          this.paths.set([]);
          this.loadingFiles.set(false);
        }
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

  /** Cycle content sort: none → ascending → descending → none. */
  toggleSort(): void {
    this.sortDir.update((d) => (d === 'none' ? 'asc' : d === 'asc' ? 'desc' : 'none'));
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
