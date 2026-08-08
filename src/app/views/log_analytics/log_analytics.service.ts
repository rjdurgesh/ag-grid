import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { LazyChild } from '../../components/filetree/filetree.component';
import { ApiDataService } from '../../shared/api-data.service';
import { API } from '../../shared/api-endpoints';
import { FileProperties, LogDirResponse, LogServer, LogServersResponse } from '../../shared/models';

/** A folder's children plus the per-folder cap info from the backend. */
export interface DirChildren {
  entries: LazyChild[];
  /** Real (uncapped) child count. */
  total: number;
  /** True when the folder was capped (more children exist than were returned). */
  truncated: boolean;
}

/**
 * Data access for the Log Analytics Hub.
 *
 * Only {@link getServers} touches the DB — it returns each server's `base_log_path`.
 * From there the UI browses by handing that base back to the backend, which reads
 * the filesystem live (no further DB calls): {@link getDirChildren} for a folder's
 * subdirs/files, {@link getFileContent} / {@link getFileProperties} for a file.
 */
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
   * Immediate children of one folder plus the per-folder cap info. Sent as a POST
   * body `{ server_id, base, path }` — `base` is the server's `base_log_path` (from
   * {@link getServers}) and the backend confirms `folderPath` sits inside it;
   * `serverId` is context only (which server we're browsing). Defence-in-depth: we
   * also drop any entry that isn't actually under the requested folder (or has `..`).
   */
  getDirChildren(serverId: string, base: string, folderPath: string): Observable<DirChildren> {
    const parent = norm(folderPath).toLowerCase();
    return this.api
      .post<LogDirResponse>(API.log.dir, { server_id: serverId, base, path: folderPath })
      .pipe(
        map((res) => {
          const entries = (res?.entries ?? []).filter((e) => {
            const p = norm(e.path).toLowerCase();
            return p.startsWith(parent + '/') && !p.split('/').some((s) => s === '..');
          });
          return { entries, total: res?.total ?? entries.length, truncated: !!res?.truncated };
        })
      );
  }

  /** Content of a single log file (`base` = its server's base path). */
  getFileContent(serverId: string, base: string, path: string): Observable<string> {
    return this.api
      .post<{ content: string }>(API.log.fileContent, { server_id: serverId, base, path })
      .pipe(map((res) => res.content));
  }

  /** Metadata for a single file (Properties dialog; `base` = its server's base path). */
  getFileProperties(serverId: string, base: string, path: string): Observable<FileProperties> {
    return this.api.post<FileProperties>(API.log.fileProperties, { server_id: serverId, base, path });
  }
}

const norm = (s: string): string => (s ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

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
