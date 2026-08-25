import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { SqlStudioService } from './sql-studio.service';
import { ConfirmService } from '../../../components/confirm/confirm.service';
import { ConfigScope } from '../../../shared/api-endpoints';
import { SqlDatabase, SqlResult } from '../../../shared/models';

/**
 * S-Studio — the Config Ops SQL console. An operator (ops-admin with `can_sql`) runs any SQL /
 * PL-SQL / deployment against ONE database in the current config scope. SELECT → results grid;
 * DML/DDL/PL-SQL → status line; Oracle errors → the ORA-xxxxx text in the panel. Manual commit —
 * include COMMIT to persist DML. Every run asks for confirmation showing the target DB.
 */
@Component({
  selector: 'app-sql-studio',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './sql-studio.component.html',
  styleUrls: ['./sql-studio.component.scss']
})
export class SqlStudioComponent implements OnInit {
  private readonly svc = inject(SqlStudioService);
  private readonly confirm = inject(ConfirmService);

  /** The config scope this console belongs to (drives the DB list). */
  readonly scope = input.required<ConfigScope>();

  readonly databases = signal<SqlDatabase[]>([]);
  readonly selectedDb = signal('');
  readonly loadingDbs = signal(true);
  readonly sql = signal('');
  readonly running = signal(false);
  readonly result = signal<SqlResult | null>(null);

  readonly selectedLabel = computed(
    () => this.databases().find((d) => d.key === this.selectedDb())?.label || this.selectedDb());

  ngOnInit(): void {
    this.svc.databases(this.scope()).subscribe({
      next: (r) => {
        this.loadingDbs.set(false);
        const dbs = r.databases ?? [];
        this.databases.set(dbs);
        if (dbs.length) { this.selectedDb.set(dbs[0].key); }
      },
      error: () => this.loadingDbs.set(false)
    });
  }

  async run(): Promise<void> {
    const sql = this.sql().trim();
    const db = this.selectedDb();
    if (!sql || !db) { return; }
    const preview = sql.replace(/\s+/g, ' ').slice(0, 160) + (sql.length > 160 ? '…' : '');
    const ok = await this.confirm.ask({
      title: `Run on ${this.selectedLabel()}`,
      message: `Target database: ${this.selectedLabel()} (${db}). Statement: ${preview}` +
        `  —  DML persists only if your script includes COMMIT.`,
      confirmLabel: 'Run', tone: 'danger'
    });
    if (!ok) { return; }
    this.running.set(true);
    this.result.set(null);
    this.svc.execute(db, sql).subscribe({
      next: (r) => { this.running.set(false); this.result.set(r.result ?? { kind: 'error', error: 'No result returned.' }); },
      error: (e) => { this.running.set(false); this.result.set({ kind: 'error', error: this.errText(e) }); }
    });
  }

  clearEditor(): void { this.sql.set(''); this.result.set(null); }
  dismissResult(): void { this.result.set(null); }

  /** Render a cell value for the grid (null → empty). */
  cell(v: unknown): string {
    return v === null || v === undefined ? '' : String(v);
  }

  private errText(e: unknown): string {
    const err = e as { error?: { detail?: string; message?: string }; message?: string };
    return err?.error?.detail || err?.error?.message || err?.message || 'The statement could not be run.';
  }
}
