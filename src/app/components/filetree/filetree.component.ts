import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output, signal } from '@angular/core';

import { LoaderComponent } from '../loader/loader.component';

/** A node in the rendered file tree. */
export interface TreeNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children: TreeNode[];
  expanded: boolean;
}

/**
 * Generic, reusable file tree. Takes a flat list of file paths and renders a
 * collapsible folder/file hierarchy with a live filter. Emits the selected file
 * path. No third-party dependency — recursion via a self-referencing template.
 */
@Component({
  selector: 'app-filetree',
  templateUrl: './filetree.component.html',
  styleUrls: ['./filetree.component.scss'],
  imports: [NgTemplateOutlet, LoaderComponent]
})
export class FiletreeComponent {
  /** Flat list of file paths, e.g. `/var/log/app/app.log`. */
  readonly paths = input<string[]>([]);
  readonly loading = input(false);

  readonly fileSelect = output<string>();

  readonly filterText = signal('');
  readonly selectedPath = signal<string | null>(null);

  /** Bumped whenever a folder is toggled so `visibleNodes` recomputes. */
  private readonly rev = signal(0);

  private readonly tree = computed<TreeNode[]>(() => buildTree(this.paths()));

  readonly fileCount = computed(() => this.paths().length);

  readonly visibleNodes = computed<TreeNode[]>(() => {
    this.rev();
    const query = this.filterText().trim().toLowerCase();
    const nodes = this.tree();
    return query ? pruneTree(nodes, query) : nodes;
  });

  readonly isFiltering = computed(() => this.filterText().trim().length > 0);

  setFilter(value: string): void {
    this.filterText.set(value);
  }

  onRowClick(node: TreeNode): void {
    if (node.type === 'folder') {
      node.expanded = !node.expanded;
      this.rev.update((v) => v + 1);
    } else {
      this.selectedPath.set(node.path);
      this.fileSelect.emit(node.path);
    }
  }

  expandAll(): void {
    setExpanded(this.tree(), true);
    this.rev.update((v) => v + 1);
  }

  collapseAll(): void {
    setExpanded(this.tree(), false);
    this.rev.update((v) => v + 1);
  }

  extension(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1) : '';
  }

  /**
   * Map a filename to an icon kind so the tree shows a distinct, colour-coded
   * glyph per file type (json, html, log, sheet, archive, script, …).
   */
  fileKind(name: string): string {
    switch (this.extension(name).toLowerCase()) {
      case 'json':
        return 'json';
      case 'html':
      case 'htm':
        return 'html';
      case 'xml':
        return 'xml';
      case 'yml':
      case 'yaml':
      case 'ini':
      case 'conf':
      case 'properties':
        return 'config';
      case 'csv':
      case 'tsv':
      case 'xlsx':
      case 'xls':
        return 'sheet';
      case 'zip':
      case 'gz':
      case 'tar':
      case '7z':
      case 'rar':
        return 'archive';
      case 'bat':
      case 'cmd':
      case 'sh':
      case 'ps1':
        return 'script';
      case 'log':
        return 'log';
      case 'txt':
      case 'md':
        return 'text';
      case 'sql':
        return 'sql';
      case 'pdf':
        return 'pdf';
      default:
        return 'file';
    }
  }
}

/** Build a nested tree from flat paths (supports `/` and `\` separators). */
function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'folder', children: [], expanded: true };
  for (const raw of paths) {
    const sep = raw.includes('\\') ? '\\' : '/';
    const parts = raw.split(/[\\/]+/).filter(Boolean);
    let cursor = root;
    let acc = '';
    parts.forEach((part, index) => {
      acc = acc ? acc + sep + part : (sep === '/' ? '/' + part : part);
      const isFile = index === parts.length - 1;
      let child = cursor.children.find((c) => c.name === part && c.type === (isFile ? 'file' : 'folder'));
      if (!child) {
        child = { name: part, path: acc, type: isFile ? 'file' : 'folder', children: [], expanded: index < 2 };
        cursor.children.push(child);
      }
      cursor = child;
    });
  }
  sortTree(root.children);
  return root.children;
}

/** Folders first, then alphabetical. */
function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  nodes.forEach((n) => sortTree(n.children));
}

function setExpanded(nodes: TreeNode[], value: boolean): void {
  nodes.forEach((n) => {
    if (n.type === 'folder') {
      n.expanded = value;
      setExpanded(n.children, value);
    }
  });
}

/** Keep files matching the query plus their ancestor folders (force-expanded). */
function pruneTree(nodes: TreeNode[], query: string): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)) {
        result.push(node);
      }
    } else {
      const kids = pruneTree(node.children, query);
      if (kids.length || node.name.toLowerCase().includes(query)) {
        result.push({ ...node, children: kids, expanded: true });
      }
    }
  }
  return result;
}
