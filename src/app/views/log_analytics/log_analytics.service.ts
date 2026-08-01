import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { TreeRoot } from '../../components/filetree/filetree.component';
import { ApiDataService } from '../../shared/api-data.service';
import { API } from '../../shared/api-endpoints';
import { FileProperties, LogServer, LogServersResponse } from '../../shared/models';

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
    return this.api.get<LogServersResponse>(API.log.servers).pipe(map(toLogServers));
  }

  /**
   * File tree roots for a server — one root per configured `base_log_path`,
   * each showing its full path with its files (relative) underneath. The API
   * returns absolute file paths; we group them under the server's base paths and
   * drop anything outside all bases (or containing `..`) — the tree is jailed to
   * the configured directories.
   */
  getFileRoots(server: LogServer): Observable<TreeRoot[]> {
    return this.api
      .get<{ paths: string[] }>(API.log.files(server.key))
      .pipe(map((res) => toFileRoots(res?.paths ?? [], server.basePaths)));
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
