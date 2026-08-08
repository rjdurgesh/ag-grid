import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { LazyChild, LazyRoot, TreeRoot } from '../../components/filetree/filetree.component';
import { ApiDataService } from '../../shared/api-data.service';
import { API } from '../../shared/api-endpoints';
import {
  FileProperties,
  LogDirResponse,
  LogFilesResponse,
  LogServer,
  LogServersResponse
} from '../../shared/models';

/**
 * The tree payload for a server, normalised for the UI. `mode` decides which
 * field the component uses: `full` → `roots` (whole tree built client-side),
 * `lazy` → `lazyRoots` (root folders only; children loaded on expand).
 */
export interface FileTreeData {
  mode: 'full' | 'lazy';
  roots: TreeRoot[];
  lazyRoots: LazyRoot[];
}

/** A folder's children plus the per-folder cap info from the backend. */
export interface DirChildren {
  entries: LazyChild[];
  /** Real (uncapped) child count. */
  total: number;
  /** True when the folder was capped (more children exist than were returned). */
  truncated: boolean;
}

/** Data access for the Log Analytics Hub. Every call goes through the API. */
@Injectable({ providedIn: 'root' })
export class LogAnalyticsService {
  private readonly api = inject(ApiDataService);

  /**
   * Server dropdown options. The API returns a map keyed by a composite id
   * (`{db_source}_{server_type}_{server_name}`); we flatten it to a sorted
   * {@link LogServer}[] for the UI. The value array can hold several rows — one
   * per configured `base_log_path` — so each server carries all of them.
   */
  getServers(): Observable<LogServer[]> {
    return this.api.get<LogServersResponse>(API.log.servers()).pipe(map(toLogServers));
  }

  /**
   * File tree for a server. Reads the `mode` the backend chose:
   *
   * - `full` (default, incl. an old `{ paths }`-only backend): group the
   *   absolute paths under the server's base paths → one {@link TreeRoot} per
   *   base, whole tree built up front. Paths outside all bases (or with `..`)
   *   are dropped — the jail guard.
   * - `lazy`: seed the tree with root folders only (from `roots`, or the
   *   server's configured base paths). Each folder's children are fetched via
   *   {@link getDirChildren} on first expand.
   */
  getFileTree(server: LogServer): Observable<FileTreeData> {
    return this.api.get<LogFilesResponse>(API.log.files(server.key)).pipe(
      map((res) => {
        if ((res?.mode ?? 'full') === 'lazy') {
          const rootPaths = (res?.roots?.length ? res.roots : server.basePaths).filter(Boolean);
          return {
            mode: 'lazy' as const,
            roots: [],
            lazyRoots: rootPaths.map((p) => ({ label: p, path: norm(p) }))
          };
        }
        return {
          mode: 'full' as const,
          roots: toFileRoots(res?.paths ?? [], server.basePaths),
          lazyRoots: []
        };
      })
    );
  }

  /**
   * Immediate children of one folder (lazy mode) plus the per-folder cap info.
   * Defence-in-depth: even though the backend jails the path, we drop any entry
   * that isn't actually under the requested folder (or contains `..`).
   */
  getDirChildren(serverId: string, folderPath: string): Observable<DirChildren> {
    const base = norm(folderPath).toLowerCase();
    return this.api.get<LogDirResponse>(API.log.dir(serverId, folderPath)).pipe(
      map((res) => {
        const entries = (res?.entries ?? []).filter((e) => {
          const p = norm(e.path).toLowerCase();
          return p.startsWith(base + '/') && !p.split('/').some((s) => s === '..');
        });
        return { entries, total: res?.total ?? entries.length, truncated: !!res?.truncated };
      })
    );
  }

  /** Content of a single log file (full path, jailed to the server's bases). */
  getFileContent(serverId: string, path: string): Observable<string> {
    return this.api
      .get<{ content: string }>(API.log.fileContent(serverId, path))
      .pipe(map((res) => res.content));
  }

  /** Metadata for a single file (Properties dialog). */
  getFileProperties(serverId: string, path: string): Observable<FileProperties> {
    return this.api.get<FileProperties>(API.log.fileProperties(serverId, path));
  }
}

const norm = (s: string): string => (s ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Group absolute file paths under the server's configured base paths, producing
 * one {@link TreeRoot} per base (full label + relative paths). Every configured
 * base appears (even with no files); paths outside all bases, or containing
 * `..`, are dropped — the jail guard.
 */
function toFileRoots(paths: string[], basePaths: string[]): TreeRoot[] {
  const roots = basePaths.map((base) => ({ label: base, baseLower: norm(base).toLowerCase(), paths: [] as string[] }));
  for (const raw of paths) {
    const p = (raw ?? '').replace(/\\/g, '/');
    const lower = p.toLowerCase();
    const match = roots.find((r) => r.baseLower && (lower === r.baseLower || lower.startsWith(r.baseLower + '/')));
    if (!match) {
      continue; // outside every configured base → refuse
    }
    const rel = p.slice(norm(match.label).length).replace(/^\/+/, '');
    if (rel && !rel.split('/').some((seg) => seg === '..')) {
      match.paths.push(rel);
    }
  }
  return roots.map((r) => ({ label: r.label, paths: r.paths }));
}

/** Flatten the keyed servers map into a sorted list of dropdown options. */
function toLogServers(res: LogServersResponse): LogServer[] {
  return Object.entries(res ?? {})
    .map(([key, rows]) => {
      const first = rows?.[0];
      return {
        key,
        serverName: first?.server_name ?? key,
        serverType: first?.server_type ?? '',
        dbSource: first?.db_source ?? '',
        basePaths: (rows ?? []).map((r) => r.base_log_path).filter(Boolean)
      };
    })
    .sort((a, b) =>
      a.dbSource.localeCompare(b.dbSource) ||
      a.serverType.localeCompare(b.serverType) ||
      a.serverName.localeCompare(b.serverName)
    );
}
