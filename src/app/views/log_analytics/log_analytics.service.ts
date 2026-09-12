import { inject, Injectable } from '@angular/core';
import { map, Observable, timeout } from 'rxjs';

import { LazyChild } from '../../components/filetree/filetree.component';
import { ApiDataService } from '../../shared/api-data.service';
import { API } from '../../shared/api-endpoints';
import {
  FileProperties,
  LogDirResponse,
  LogFileResponse,
  LogServer,
  LogServersResponse
} from '../../shared/models';

/** Paging window for a large-file read (all optional; omitted for small files). */
export interface FileWindowOpts {
  /** Byte offset to start the window at. */
  offset?: number;
  /** Max bytes for this window (server clamps to a safe ceiling). */
  length?: number;
  /** Read the LAST `length` bytes instead — newest-first "tail". */
  fromEnd?: boolean;
}

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
/** Client-side ceiling for a single folder-listing call. A configured path that's gone/unreachable (a dead
 *  UNC share can block server-side) becomes a TimeoutError → the tree shows one "path not available" folder
 *  and stays responsive, instead of an endless spinner. */
const DIR_CALL_TIMEOUT_MS = 20_000;

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
        timeout(DIR_CALL_TIMEOUT_MS),
        map((res) => {
          const entries = (res?.entries ?? []).filter((e) => {
            const p = norm(e.path).toLowerCase();
            return p.startsWith(parent + '/') && !p.split('/').some((s) => s === '..');
          });
          return { entries, total: res?.total ?? entries.length, truncated: !!res?.truncated };
        })
      );
  }

  /**
   * File content for the preview. Returns `{ mode:'full', … }` for a small file
   * (whole content) or `{ mode:'window', … }` for a large one (a line-aligned byte
   * window). Pass {@link FileWindowOpts} to page a large file; omit for the first read.
   */
  getFile(serverId: string, base: string, path: string, opts: FileWindowOpts = {}): Observable<LogFileResponse> {
    const body: Record<string, unknown> = { server_id: serverId, base, path };
    if (opts.offset != null) {
      body['offset'] = opts.offset;
    }
    if (opts.length != null) {
      body['length'] = opts.length;
    }
    if (opts.fromEnd) {
      body['from_end'] = true;
    }
    return this.api.post<LogFileResponse>(API.log.fileContent, body);
  }

  /** URL for a streamed whole-file download (`base` = its server's base path). */
  downloadUrl(base: string, path: string): string {
    return API.log.fileDownload(base, path);
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
