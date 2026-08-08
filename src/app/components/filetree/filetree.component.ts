import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, input, output, signal } from '@angular/core';

import { LoaderComponent } from '../loader/loader.component';

/** A node in the rendered file tree. */
export interface TreeNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children: TreeNode[];
  expanded: boolean;
  /** Lazy mode: false until this folder's children have been fetched. */
  loaded?: boolean;
  /** Lazy mode: true while this folder's children are being fetched. */
  loading?: boolean;
  /** Lazy mode: real child count when the folder was capped (0 = not capped). */
  truncatedTotal?: number;
}

/**
 * A labelled root for the tree — e.g. one configured `base_log_path`. Its
 * `label` (the full base path) is shown as a single, un-split root node and its
 * `paths` (relative to that base) become its subtree.
 */
export interface TreeRoot {
  label: string;
  paths: string[];
}

/**
 * A root for **lazy** mode — just the folder itself; its children are fetched on
 * demand (first expand). `label` is the display name, `path` the full path used
 * to request its children.
 */
export interface LazyRoot {
  label: string;
  path: string;
}

/** One immediate child supplied to {@link FiletreeComponent.applyChildren}. */
export interface LazyChild {
  name: string;
  type: 'folder' | 'file';
  path: string;
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
  /**
   * Labelled roots (one per configured base path). When provided, takes
   * precedence over `paths`: each root's full label is shown as a single node
   * and its relative `paths` form the subtree.
   */
  readonly roots = input<TreeRoot[] | null>(null);
  /**
   * Lazy roots (one per base path). When provided, takes precedence over
   * everything: only the root folders are shown and each folder's children are
   * requested via {@link folderLoad} on first expand. Drives "lazy" mode.
   */
  readonly lazyRoots = input<LazyRoot[] | null>(null);
  readonly loading = input(false);

  readonly fileSelect = output<string>();
  /** Lazy mode: a folder was expanded and needs its children fetched. */
  readonly folderLoad = output<{ path: string }>();

  readonly filterText = signal('');
  readonly selectedPath = signal<string | null>(null);

  /** True when the tree is operating in lazy (load-on-expand) mode. */
  readonly isLazy = computed(() => !!this.lazyRoots()?.length);

  /**
   * The working tree. Held as mutable state (not a pure computed) because in
   * lazy mode it grows as folders load, and expand/collapse toggles node flags
   * in place. Re-seeded whenever the inputs change (e.g. a different server).
   */
  private readonly treeState = signal<TreeNode[]>([]);

  /** Bumped whenever a node is mutated in place so `visibleNodes` recomputes. */
  private readonly rev = signal(0);

  constructor() {
    // (Re)build the tree whenever the source inputs change. Lazy roots win, then
    // labelled roots, then a flat path list.
    effect(() => {
      const lazy = this.lazyRoots();
      const roots = this.roots();
      const paths = this.paths();
      let next: TreeNode[];
      if (lazy && lazy.length) {
        next = lazy.map((r) => ({
          name: r.label,
          path: stripTrailingSep(r.path),
          type: 'folder' as const,
          children: [],
          expanded: false,
          loaded: false,
          loading: false
        }));
      } else if (roots && roots.length) {
        next = buildRootedTree(roots);
      } else {
        next = buildTree(paths);
      }
      this.treeState.set(next);
      this.rev.update((v) => v + 1);
    });
  }

  readonly fileCount = computed(() => {
    // Lazy mode can't know the total up front — report what's loaded so far.
    if (this.isLazy()) {
      this.rev();
      return countFiles(this.treeState());
    }
    const roots = this.roots();
    return roots && roots.length
      ? roots.reduce((n, r) => n + r.paths.length, 0)
      : this.paths().length;
  });

  readonly visibleNodes = computed<TreeNode[]>(() => {
    this.rev();
    const query = this.filterText().trim().toLowerCase();
    const nodes = this.treeState();
    return query ? pruneTree(nodes, query) : nodes;
  });

  readonly isFiltering = computed(() => this.filterText().trim().length > 0);

  setFilter(value: string): void {
    this.filterText.set(value);
  }

  onRowClick(node: TreeNode): void {
    if (node.type !== 'folder') {
      this.selectedPath.set(node.path);
      this.fileSelect.emit(node.path);
      return;
    }
    // Lazy folder not yet loaded → request its children, show it expanding.
    if (this.isLazy() && !node.loaded && !node.loading) {
      node.loading = true;
      node.expanded = true;
      this.rev.update((v) => v + 1);
      this.folderLoad.emit({ path: node.path });
      return;
    }
    node.expanded = !node.expanded;
    this.rev.update((v) => v + 1);
  }

  /**
   * Attach a lazily-loaded folder's children (called by the parent once the
   * `dir` API returns). Sub-folders start collapsed/unloaded so they load on
   * their own expand. `truncatedTotal` > 0 means the backend capped the folder;
   * the tree shows a "showing N of M" note.
   */
  applyChildren(path: string, entries: LazyChild[], truncatedTotal = 0): void {
    const node = findNode(this.treeState(), stripTrailingSep(path));
    if (!node) {
      return;
    }
    node.children = entries.map((e) => ({
      name: e.name,
      path: e.path,
      type: e.type,
      children: [],
      expanded: false,
      loaded: e.type === 'file',
      loading: false
    }));
    sortTree(node.children);
    node.loaded = true;
    node.loading = false;
    node.expanded = true;
    node.truncatedTotal = truncatedTotal;
    this.rev.update((v) => v + 1);
  }

  /** Mark a lazy folder's load as failed so it can be retried. */
  markFolderError(path: string): void {
    const node = findNode(this.treeState(), stripTrailingSep(path));
    if (node) {
      node.loading = false;
      node.loaded = false;
      node.expanded = false;
      this.rev.update((v) => v + 1);
    }
  }

  expandAll(): void {
    // Only toggles already-loaded nodes; lazy mode never bulk-fetches.
    setExpanded(this.treeState(), true);
    this.rev.update((v) => v + 1);
  }

  collapseAll(): void {
    setExpanded(this.treeState(), false);
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

/**
 * Build a forest where each {@link TreeRoot} becomes one un-split root node
 * (its full `label`, e.g. `C:/my/cib`), with its relative `paths` as the
 * subtree. Each file node's `path` is the full absolute path (base + relative)
 * so selection reports the real location. The first root starts expanded.
 */
function buildRootedTree(roots: TreeRoot[]): TreeNode[] {
  return roots.map((root, i) => {
    const label = root.label;
    const sep = label.includes('\\') ? '\\' : '/';
    const baseAcc = label.replace(/[\\/]+$/, '');
    const rootNode: TreeNode = { name: label, path: label, type: 'folder', children: [], expanded: i === 0 };
    for (const rawRel of root.paths) {
      const parts = rawRel.split(/[\\/]+/).filter(Boolean);
      let cursor = rootNode;
      let acc = baseAcc;
      parts.forEach((part, index) => {
        acc = acc + sep + part;
        const isFile = index === parts.length - 1;
        let child = cursor.children.find((c) => c.name === part && c.type === (isFile ? 'file' : 'folder'));
        if (!child) {
          child = { name: part, path: acc, type: isFile ? 'file' : 'folder', children: [], expanded: false };
          cursor.children.push(child);
        }
        cursor = child;
      });
    }
    sortTree(rootNode.children);
    return rootNode;
  });
}

/** Drop a trailing `/` or `\` so a base path matches its node's stored path. */
function stripTrailingSep(path: string): string {
  return (path ?? '').replace(/[\\/]+$/, '');
}

/** Count file (non-folder) nodes currently in the tree. */
function countFiles(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += node.type === 'file' ? 1 : countFiles(node.children);
  }
  return n;
}

/** Depth-first search for a node by its full path. */
function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    const hit = findNode(node.children, path);
    if (hit) {
      return hit;
    }
  }
  return null;
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
