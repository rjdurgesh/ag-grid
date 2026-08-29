import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';

import { GrantInput, UserManagementService } from './user-management.service';
import { ConfirmService } from '../../components/confirm/confirm.service';
import { AccessCatalogue, GrantRow, OpsAdmin, UserLookup } from '../../shared/models';

/** The friendly "grant type" a form row builds (maps to resource_type + scope). */
type GrantKind =
  | 'full' | 'screen' | 'server' | 'config_category' | 'config_table'
  | 'infra_app' | 'service_app' | 'oracle_db' | 'section';

type Level = 'READ' | 'WRITE' | 'DENY';
interface Toast { kind: 'ok' | 'err' | 'info'; text: string; }

const CUSTOM = '__custom__';

/**
 * User Management — the ops-admin console for handing out access. Gated by `ols_ops_access`
 * (opsAdminGuard) and driven entirely by `GET /admin/catalogue`, so newly-added servers / DBs /
 * (registered) screens appear automatically. Two jobs: (1) grant/revoke `ols_app_access` rows for
 * any active OLS user; (2) manage the ops-admin gate itself. See RBAC_DESIGN.md §User Management.
 */
@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './user_management.component.html',
  styleUrls: ['./user_management.component.scss']
})
export class UserManagementComponent implements OnInit {
  private readonly svc = inject(UserManagementService);
  private readonly confirm = inject(ConfirmService);

  // --- Catalogue -------------------------------------------------------------
  readonly catalogue = signal<AccessCatalogue | null>(null);

  // --- Target user + their grants -------------------------------------------
  readonly uidInput = signal('');
  readonly lookup = signal<UserLookup | null>(null);
  readonly grants = signal<GrantRow[]>([]);
  readonly loadingUser = signal(false);
  /** The user whose grants are currently shown (locked once loaded, so edits target the right UID). */
  readonly loadedUid = computed(() => {
    const lk = this.lookup();
    return lk && lk.active ? lk.username : '';
  });

  // --- Add-grant form state --------------------------------------------------
  readonly kind = signal<GrantKind>('screen');
  readonly scope = signal('group');        // config sub-screen (group/cib/retail)
  readonly selKey = signal('');            // chosen dropdown key (screen/app/db/server/category/section)
  readonly freeKey = signal('');           // free-text key (config table, custom server)
  readonly level = signal<Level>('READ');
  readonly env = signal('PROD');
  readonly sectionDb = signal('');         // '' = hide section on every DB

  // --- Staged grants (build several, then apply in one go) -------------------
  readonly staged = signal<GrantRow[]>([]);
  readonly applying = signal(false);
  readonly allLevels: Level[] = ['READ', 'WRITE', 'DENY'];

  // --- Copy access from another user (fetch + preview, then copy) ------------
  readonly copyFromUid = signal('');
  readonly fetchingSource = signal(false);
  readonly sourceUser = signal<UserLookup | null>(null);   // the validated source (from ols_users)
  readonly sourceGrants = signal<GrantRow[]>([]);          // the source's grants (from ols_app_access)
  readonly showSourceModal = signal(false);
  /** Copy is enabled only after a successful fetch of an active source with ≥1 grant. */
  readonly canCopy = computed(() => !!this.sourceUser()?.active && this.sourceGrants().length > 0);

  // --- Ops-admin gate --------------------------------------------------------
  readonly opsAdmins = signal<OpsAdmin[]>([]);
  readonly opsUidInput = signal('');
  readonly savingOps = signal(false);

  readonly toast = signal<Toast | null>(null);

  // Log Analytics + Infra Health are ungated for everyone (RBAC_DESIGN §2), so they are not
  // grantable here — only the opt-in features appear.
  readonly kinds: { key: GrantKind; label: string }[] = [
    { key: 'full', label: 'Full access (everything)' },
    { key: 'screen', label: 'Screen visibility' },
    { key: 'config_category', label: 'Config Ops — table category' },
    { key: 'config_table', label: 'Config Ops — single table' },
    { key: 'service_app', label: 'Service Console — app' },
    { key: 'oracle_db', label: 'Oracle Command Center — database' },
    { key: 'section', label: 'Hide an OCC section' }
  ];

  ngOnInit(): void {
    this.svc.catalogue().subscribe({
      next: (r) => { this.catalogue.set(r.catalogue); this.resetForm(); },
      error: (e) => this.fail(e, 'Could not load the resource catalogue')
    });
    this.refreshOps();
  }

  // --- Derived form helpers --------------------------------------------------

  /** Options for the main key dropdown, given the current kind. */
  readonly keyOptions = computed<{ value: string; label: string }[]>(() => {
    const c = this.catalogue();
    if (!c) { return []; }
    switch (this.kind()) {
      case 'screen':
        return c.screens.map((s) => ({ value: s.key, label: s.label }));
      case 'server':
        return [{ value: '*', label: 'All servers (*)' },
          ...c.servers.map((s) => ({ value: s, label: s })),
          { value: CUSTOM, label: 'Other (type a name)…' }];
      case 'config_category':
        return c.config.categories.map((x) => ({ value: x.key, label: x.label }));
      case 'infra_app':
      case 'service_app':
        return [{ value: '*', label: 'All apps (*)' }, ...c.apps.map((a) => ({ value: a.key, label: a.label }))];
      case 'oracle_db':
        return [{ value: '*', label: 'All databases (*)' }, ...c.databases.map((d) => ({ value: d.key, label: d.label }))];
      case 'section':
        return c.sections.map((x) => ({ value: x.key, label: x.label }));
      default:
        return [];
    }
  });

  readonly usesScope = computed(() => this.kind() === 'config_category' || this.kind() === 'config_table');
  readonly usesFreeKey = computed(() =>
    this.kind() === 'config_table' || (this.kind() === 'server' && this.selKey() === CUSTOM));
  readonly usesKeyDropdown = computed(() => this.keyOptions().length > 0 && this.kind() !== 'config_table');
  readonly usesSectionDb = computed(() => this.kind() === 'section');

  /** Which access levels make sense for the current kind (WRITE only where it means something). */
  readonly allowedLevels = computed<Level[]>(() => {
    switch (this.kind()) {
      case 'section':
        return ['DENY'];                                   // sections are hide-only
      case 'server':
      case 'infra_app':
      case 'service_app':
        return ['READ', 'DENY'];                           // read-only screens (+ exclusion)
      case 'screen': {
        const sc = this.catalogue()?.screens.find((s) => s.key === this.selKey());
        return sc?.write_capable ? ['READ', 'WRITE'] : ['READ'];
      }
      default:
        return ['READ', 'WRITE', 'DENY'];                  // full / config / oracle_db
    }
  });

  readonly dbOptions = computed(() => this.catalogue()?.databases ?? []);
  readonly envOptions = computed(() => this.catalogue()?.app_envs ?? ['PROD', 'STG', 'DEV', '*']);

  /** Change the grant type and reset the dependent fields to valid defaults. */
  setKind(k: GrantKind): void {
    this.kind.set(k);
    this.resetForm();
  }

  private resetForm(): void {
    const opts = this.keyOptions();
    this.selKey.set(opts.length ? opts[0].value : '*');
    this.freeKey.set('');
    this.sectionDb.set('');
    const levels = this.allowedLevels();
    this.level.set(levels[0]);
  }

  /** Re-evaluate the level when the chosen screen changes (write-capable vs not). */
  onKeyChange(): void {
    const levels = this.allowedLevels();
    if (!levels.includes(this.level())) { this.level.set(levels[0]); }
  }

  // --- Load a user -----------------------------------------------------------

  loadUser(): void {
    const uid = this.uidInput().trim();
    if (!uid) { return; }
    this.loadingUser.set(true);
    this.toast.set(null);
    this.staged.set([]);            // don't carry a previous user's pending rows over
    this.copyFromUid.set('');       // reset the copy-source picker for the new target
    this.sourceUser.set(null);
    this.sourceGrants.set([]);
    this.showSourceModal.set(false);
    this.svc.loadUser(uid).subscribe({
      next: (r) => {
        this.loadingUser.set(false);
        this.lookup.set(r.lookup);
        this.grants.set(r.lookup.active ? (r.grants ?? []) : []);
        if (!r.lookup.active) {
          this.toast.set({ kind: 'err', text: r.lookup.message || `The ${uid} user is not active in OLS.` });
        }
      },
      error: (e) => { this.loadingUser.set(false); this.fail(e, 'Could not load the user'); }
    });
  }

  // --- Add / revoke grants ---------------------------------------------------

  private buildGrant(): GrantInput | null {
    const username = this.loadedUid();
    if (!username) { return null; }
    const env = this.env();
    const level = this.level();
    const k = this.kind();
    const dropKey = this.selKey();
    const free = this.freeKey().trim();

    let resource_type = '';
    let resource_scope = '';
    let resource_key = '*';

    switch (k) {
      case 'full':
        resource_type = 'SCREEN'; resource_scope = '*'; resource_key = '*'; break;
      case 'screen':
        resource_type = 'SCREEN'; resource_scope = dropKey; resource_key = '*'; break;
      case 'server':
        resource_type = 'SERVER'; resource_scope = 'log_analytics';
        resource_key = dropKey === CUSTOM ? free : dropKey; break;
      case 'config_category':
        resource_type = 'TABLE_CATEGORY'; resource_scope = 'config_ops:' + this.scope(); resource_key = dropKey; break;
      case 'config_table':
        resource_type = 'TABLE'; resource_scope = 'config_ops:' + this.scope(); resource_key = free; break;
      case 'infra_app':
        resource_type = 'APP'; resource_scope = 'infra_health'; resource_key = dropKey; break;
      case 'service_app':
        resource_type = 'APP'; resource_scope = 'service_console'; resource_key = dropKey; break;
      case 'oracle_db':
        resource_type = 'DB'; resource_scope = 'oracle_command_center'; resource_key = dropKey; break;
      case 'section':
        resource_type = 'SECTION';
        resource_scope = 'oracle_command_center' + (this.sectionDb() ? ':' + this.sectionDb() : '');
        resource_key = dropKey; break;
    }

    if (!resource_key) { return null; }         // free-text kinds require a value
    return { username, resource_type, resource_scope, resource_key, access_level: level, app_env: env };
  }

  /** Pick a level from the segmented control (ignores levels invalid for the current kind). */
  setLevel(lv: Level): void {
    if (this.allowedLevels().includes(lv)) { this.level.set(lv); }
  }

  private sameKey(a: GrantRow, b: GrantRow): boolean {
    return a.resource_type === b.resource_type && a.resource_scope === b.resource_scope &&
      (a.resource_key || '').toUpperCase() === (b.resource_key || '').toUpperCase() && a.app_env === b.app_env;
  }

  /** Stage the current form selection (does NOT save yet). Re-adding the same resource updates it. */
  addToList(): void {
    const g = this.buildGrant();
    if (!g) {
      this.toast.set({ kind: 'err', text: 'Fill in the resource before adding it to the list.' });
      return;
    }
    const row = g as unknown as GrantRow;
    const existed = this.staged().some((s) => this.sameKey(s, row));
    const next = this.staged().filter((s) => !this.sameKey(s, row));
    next.push(row);
    this.staged.set(next);
    this.toast.set({ kind: 'info', text: `${existed ? 'Updated' : 'Added'} “${this.describe(row)}” — click Apply to save.` });
  }

  removeStaged(row: GrantRow): void {
    this.staged.set(this.staged().filter((s) => s !== row));
  }

  clearStaged(): void {
    this.staged.set([]);
  }

  /** Editing the source id invalidates any prior fetch, so Copy disables until re-fetched. */
  onCopyUidChange(v: string): void {
    this.copyFromUid.set(v);
    if (this.sourceUser()) { this.sourceUser.set(null); this.sourceGrants.set([]); }
  }

  /** Validate the source user against `ols_users` and load their grants (from `ols_app_access`).
   *  Only after this succeeds does the Copy button enable. Does NOT change the target. */
  fetchSource(): void {
    const src = this.copyFromUid().trim();
    const target = this.loadedUid();
    if (!src || !target) { return; }
    if (src.toUpperCase() === target.toUpperCase()) {
      this.toast.set({ kind: 'err', text: 'Pick a different user to copy from.' });
      return;
    }
    this.fetchingSource.set(true);
    this.sourceUser.set(null);
    this.sourceGrants.set([]);
    this.svc.loadUser(src).subscribe({
      next: (r) => {
        this.fetchingSource.set(false);
        this.sourceUser.set(r.lookup);
        if (!r.lookup.active) {
          this.toast.set({ kind: 'err', text: r.lookup.message || `The ${src} user is not active in OLS.` });
          return;
        }
        this.sourceGrants.set(r.grants ?? []);
        const n = (r.grants ?? []).length;
        this.toast.set({ kind: 'info', text: `${r.lookup.username} found — ${n} grant${n === 1 ? '' : 's'}. Review, then Copy.` });
      },
      error: (e) => { this.fetchingSource.set(false); this.fail(e, 'Could not fetch that user'); }
    });
  }

  openSourceModal(): void {
    if (this.canCopy() || this.sourceUser()?.active) { this.showSourceModal.set(true); }
  }
  closeSourceModal(): void { this.showSourceModal.set(false); }

  /** Stage the (already-fetched) source grants, retargeted to the loaded user. Review then Apply. */
  copyFrom(): void {
    const target = this.loadedUid();
    const su = this.sourceUser();
    if (!su?.active || !target) { return; }
    const srcGrants = this.sourceGrants();
    if (!srcGrants.length) {
      this.toast.set({ kind: 'info', text: `${su.username} has no grants to copy.` });
      return;
    }
    const merged = [...this.staged()];
    for (const g of srcGrants) {
      const row = { ...g, username: target } as GrantRow;
      const i = merged.findIndex((s) => this.sameKey(s, row));
      if (i >= 0) { merged[i] = row; } else { merged.push(row); }
    }
    this.staged.set(merged);
    this.showSourceModal.set(false);
    this.toast.set({ kind: 'info', text: `Staged ${srcGrants.length} grant${srcGrants.length === 1 ? '' : 's'} from ${su.username} — review and Apply.` });
  }

  /** Commit every staged grant in one action (parallel upserts), then refresh the list. Confirmed. */
  async applyStaged(): Promise<void> {
    const list = this.staged();
    if (!list.length || !this.loadedUid()) { return; }
    const n = list.length;
    const ok = await this.confirm.ask({
      title: 'Save access grants',
      message: `Save ${n} grant${n === 1 ? '' : 's'} to ${this.loadedUid()}? Existing grants for the same resource are updated.`,
      confirmLabel: `Save ${n} grant${n === 1 ? '' : 's'}`, tone: 'primary'
    });
    if (!ok) { return; }
    this.applying.set(true);
    forkJoin(list.map((g) => this.svc.grant(g as unknown as GrantInput))).subscribe({
      next: (results) => {
        this.applying.set(false);
        // Upserts are cumulative — take the response that saw the most rows as the authoritative list.
        const fullest = results.reduce((a, b) => ((b?.grants?.length ?? 0) >= (a?.grants?.length ?? 0) ? b : a));
        if (fullest?.grants) { this.grants.set(fullest.grants); }
        this.staged.set([]);
        this.toast.set({ kind: 'ok', text: `Saved ${n} grant${n === 1 ? '' : 's'} to ${this.loadedUid()}.` });
      },
      error: (e) => { this.applying.set(false); this.fail(e, 'Could not apply the grants'); }
    });
  }

  async revoke(row: GrantRow): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Revoke access',
      message: `Revoke “${this.describe(row)}” from ${row.username}? This is a hard delete and cannot be undone.`,
      confirmLabel: 'Revoke', tone: 'danger'
    });
    if (!ok) { return; }
    this.svc.revoke(row).subscribe({
      next: (r) => {
        if (r.grants) { this.grants.set(r.grants); }
        else { this.grants.set(this.grants().filter((x) => x !== row)); }
        this.toast.set({ kind: 'ok', text: `Revoked ${this.describe(row)}.` });
      },
      error: (e) => this.fail(e, 'Could not revoke the grant')
    });
  }

  // --- Ops-admin gate --------------------------------------------------------

  private refreshOps(): void {
    this.svc.ops('list').subscribe({
      next: (r) => this.opsAdmins.set(r.ops_admins ?? []),
      error: () => { /* non-fatal: the panel just stays empty */ }
    });
  }

  async addOps(): Promise<void> {
    const uid = this.opsUidInput().trim();
    if (!uid) { return; }
    const ok = await this.confirm.ask({
      title: 'Add ops-admin',
      message: `Give ${uid} access to User Management? They will be able to grant access to any OLS user.`,
      confirmLabel: 'Add', tone: 'primary'
    });
    if (!ok) { return; }
    this.savingOps.set(true);
    this.svc.ops('add', uid).subscribe({
      next: (r) => {
        this.savingOps.set(false);
        this.opsAdmins.set(r.ops_admins ?? []);
        this.opsUidInput.set('');
        this.toast.set({ kind: 'ok', text: `${uid} can now use User Management.` });
      },
      error: (e) => { this.savingOps.set(false); this.fail(e, 'Could not add the ops-admin'); }
    });
  }

  /** Edit = flip the ops-admin's active flag (disable keeps the row; enable turns it back on). */
  async editOps(o: OpsAdmin): Promise<void> {
    const disabling = o.is_active === 'Y';
    const ok = await this.confirm.ask({
      title: disabling ? 'Disable ops-admin' : 'Enable ops-admin',
      message: disabling
        ? `Disable ${o.username}? The row is kept but they lose access to User Management until re-enabled.`
        : `Re-enable ${o.username}'s access to User Management?`,
      confirmLabel: disabling ? 'Disable' : 'Enable', tone: disabling ? 'danger' : 'success'
    });
    if (!ok) { return; }
    this.svc.ops(disabling ? 'disable' : 'enable', o.username).subscribe({
      next: (r) => {
        this.opsAdmins.set(r.ops_admins ?? []);
        this.toast.set({ kind: 'info', text: `${o.username} ${disabling ? 'disabled' : 'enabled'}.` });
      },
      error: (e) => this.fail(e, 'Could not update the ops-admin')
    });
  }

  /** Grant / revoke User Management (super-admin) for an operator — independent of S-Studio. */
  async toggleUsers(o: OpsAdmin): Promise<void> {
    const granting = o.can_users !== 'Y';
    const ok = await this.confirm.ask({
      title: granting ? 'Grant User Management' : 'Revoke User Management',
      message: granting
        ? `Grant ${o.username} User Management (they can hand out access to any OLS user)?`
        : `Revoke ${o.username}'s User Management access? (Any S-Studio access is kept.)`,
      confirmLabel: granting ? 'Grant' : 'Revoke', tone: granting ? 'primary' : 'danger'
    });
    if (!ok) { return; }
    this.svc.ops(granting ? 'users_on' : 'users_off', o.username).subscribe({
      next: (r) => {
        this.opsAdmins.set(r.ops_admins ?? []);
        this.toast.set({ kind: 'info', text: `${o.username} User Management ${granting ? 'granted' : 'revoked'}.` });
      },
      error: (e) => this.fail(e, 'Could not update User Management access')
    });
  }

  /** Grant / revoke S-Studio (the SQL console) for an operator — independent of User Management. */
  async toggleSql(o: OpsAdmin): Promise<void> {
    const granting = o.can_sql !== 'Y';
    const ok = await this.confirm.ask({
      title: granting ? 'Grant S-Studio' : 'Revoke S-Studio',
      message: granting
        ? `Grant ${o.username} access to S-Studio — the Config Ops console for running raw SQL / DDL on the databases? Assign only to trusted operators.`
        : `Revoke ${o.username}'s S-Studio access?`,
      confirmLabel: granting ? 'Grant' : 'Revoke', tone: granting ? 'primary' : 'danger'
    });
    if (!ok) { return; }
    this.svc.ops(granting ? 'sql_on' : 'sql_off', o.username).subscribe({
      next: (r) => {
        this.opsAdmins.set(r.ops_admins ?? []);
        this.toast.set({ kind: 'info', text: `${o.username} S-Studio ${granting ? 'granted' : 'revoked'}.` });
      },
      error: (e) => this.fail(e, 'Could not update S-Studio access')
    });
  }

  async removeOps(uid: string): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Remove ops-admin',
      message: `Remove ${uid} from User Management? This permanently deletes the row (no audit is kept).`,
      confirmLabel: 'Remove', tone: 'danger'
    });
    if (!ok) { return; }
    this.svc.ops('remove', uid).subscribe({
      next: (r) => {
        this.opsAdmins.set(r.ops_admins ?? []);
        this.toast.set({ kind: 'info', text: `${uid} removed from User Management.` });
      },
      error: (e) => this.fail(e, 'Could not remove the ops-admin')
    });
  }

  // --- Display helpers -------------------------------------------------------

  /** A human-readable one-liner for a grant row (uses catalogue labels where possible). */
  describe(g: GrantRow): string {
    const c = this.catalogue();
    const key = g.resource_key;
    switch (g.resource_type) {
      case 'SCREEN':
        if (g.resource_scope === '*') { return 'Full access'; }
        return 'Screen · ' + (c?.screens.find((s) => s.key === g.resource_scope)?.label ?? g.resource_scope);
      case 'SERVER':
        return 'Log server · ' + (key === '*' ? 'all servers' : key);
      case 'APP':
        return (g.resource_scope === 'service_console' ? 'Service app · ' : 'Infra app · ') +
          (key === '*' ? 'all apps' : key);
      case 'DB':
        return 'OCC database · ' + (key === '*' ? 'all databases' :
          (c?.databases.find((d) => d.key === key)?.label ?? key));
      case 'TABLE_CATEGORY':
        return 'Config ' + this.scopeLabel(g.resource_scope) + ' · category ' + key;
      case 'TABLE':
        return 'Config ' + this.scopeLabel(g.resource_scope) + ' · table ' + key;
      case 'SECTION': {
        const dbPart = g.resource_scope.includes(':') ? ' on ' + g.resource_scope.split(':')[1] : ' (all DBs)';
        return 'Hide OCC section · ' + (c?.sections.find((x) => x.key === key)?.label ?? key) + dbPart;
      }
      default:
        return `${g.resource_type} · ${g.resource_scope} · ${key}`;
    }
  }

  /** Short category tag for a grant row (the chip before its description). */
  typeTag(g: GrantRow): string {
    switch (g.resource_type) {
      case 'SCREEN': return g.resource_scope === '*' ? 'Full' : 'Screen';
      case 'SERVER': return 'Server';
      case 'APP': return g.resource_scope === 'service_console' ? 'Service' : 'Infra';
      case 'DB': return 'Database';
      case 'TABLE_CATEGORY': return 'Category';
      case 'TABLE': return 'Table';
      case 'SECTION': return 'Section';
      default: return g.resource_type;
    }
  }

  private scopeLabel(scope: string): string {
    const s = scope.replace('config_ops:', '');
    return this.catalogue()?.config.scopes.find((x) => x.key === s)?.label ?? s;
  }

  levelClass(level: string): string {
    return level === 'WRITE' ? 'lv-write' : level === 'DENY' ? 'lv-deny' : 'lv-read';
  }

  private fail(e: unknown, fallback: string): void {
    const err = e as { error?: { detail?: string; message?: string }; message?: string };
    const text = err?.error?.detail || err?.error?.message || err?.message || fallback;
    this.toast.set({ kind: 'err', text });
  }
}
