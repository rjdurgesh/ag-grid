import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { ApiDataService } from '../../shared/api-data.service';
import { API } from '../../shared/api-endpoints';
import { FileProperties, ServerInfo } from '../../shared/models';

/** Data access for the Log Analytics Hub. Every call goes through the API. */
@Injectable({ providedIn: 'root' })
export class LogAnalyticsService {
  private readonly api = inject(ApiDataService);

  /** Server dropdown options. */
  getServers(): Observable<ServerInfo[]> {
    return this.api.get<ServerInfo[]>(API.log.servers);
  }

  /** Flat list of file paths for a server (used to build the file tree). */
  getFiles(serverId: string): Observable<string[]> {
    return this.api.get<{ paths: string[] }>(API.log.files(serverId)).pipe(map((res) => res.paths));
  }

  /** Content of a single log file. */
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
