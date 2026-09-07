import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';

import { GrantInput, UserManagementService } from './user-management.service';
import { ConfirmService } from '../../components/confirm/confirm.service';
import { RbacService } from '../../auth/rbac.service';
import { AccessCatalogue, AccessUser, GrantRow, OpsAdmin, UserLookup } from '../../shared/models';

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
  private readonly rbac = inject(RbacService);

  // --- Catalogue -------------------------------------------------------------
  readonly catalogue = signal<AccessCatalogue | null>(null);

  // --- "Who has access" roster (all users with ≥1 grant) ---------------------
  readonly accessUsers = signal<AccessUser[]>([]);
  readonly loadingUsers = signal(false);
  /** Per-column filters (name / username / email / guid / features). */
  readonly colFilters = signal<Record<string, string>>({ name: '', username: '', email: '', guid: '', features: '' });
  readonly usersSortKey = signal<'name' | 'username' | 'email' | 'grants'>('name');
  readonly usersSortDir = signal<'asc' | 'desc'>('asc');
  readonly pageSizeOptions = [5, 10, 20, 100];
  readonly pageSize = signal(10);
  readonly page = signal(0);

  private colText(u: AccessUser, col: string): string {
    switch (col) {
      case 'name': return (u.display_name || u.username);
      case 'username': return u.username;
      case 'email': return u.email ?? '';
      case 'guid': return u.guid ?? '';
      case 'features': return (u.features ?? []).join(' ');
      default: return '';
    }
  }

  /** Roster after per-column filters + sort (all matching rows, before paging). */
  readonly filteredUsers = computed<AccessUser[]>(() => {
    const f = this.colFilters();
    const active = Object.entries(f).filter(([, v]) => (v || '').trim());
    let list = this.accessUsers();
    if (active.length) {
      list = list.filter((u) => active.every(([col, v]) => this.colText(u, col).toLowerCase().includes(v.trim().toLowerCase())));
    }
    const key = this.usersSortKey();
    const dir = this.usersSortDir() === 'asc' ? 1 : -1;
    const val = (u: AccessUser): string | number =>
      key === 'grants' ? u.grant_count
        : key === 'username' ? u.username.toLowerCase()
        : key === 'email' ? (u.email ?? '').toLowerCase()
        : (u.display_name || u.username).toLowerCase();
    return [...list].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (typeof av === 'number' && typeof bv === 'number') { return (av - bv) * dir; }
      return String(av).localeCompare(String(bv)) * dir;
    });
  });

  /** Total pages for the current filter (≥1). */
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.filteredUsers().length / this.pageSize())));
  /** The rows on the current page (page clamped to range). */
  readonly pagedUsers = computed<AccessUser[]>(() => {
    const p = Math.min(this.page(), this.pageCount() - 1);
    const start = p * this.pageSize();
    return this.filteredUsers().slice(start, start + this.pageSize());
  });

  /** Update one column filter and jump back to the first page. */
  setColFilter(col: string, value: string): void {
    this.colFilters.set({ ...this.colFilters(), [col]: value });
    this.page.set(0);
  }
  /** Change rows-per-page (5/10/20/100) and jump back to the first page. */
  setPageSize(n: number): void { this.pageSize.set(n); this.page.set(0); }
  prevPage(): void { this.page.set(Math.max(0, this.page() - 1)); }
  nextPage(): void { this.page.set(Math.min(this.pageCount() - 1, this.page() + 1)); }

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

  // --- Screen tabs (each has its OWN gate) -----------------------------------
  /** 'access' = grant/revoke for a user; 'ops' = manage who can use this screen. */
  readonly activeTab = signal<'access' | 'ops'>('access');
  /** "User access" tab — grant-driven (ADMIN / SCREEN grant / ops-admin). */
  readonly canUserTab = computed(() => this.rbac.canView('user_management'));
  /** "Manage access" tab — the exclusive `ols_ops_access` gate only. */
  readonly canOpsTab = computed(() => this.rbac.isOpsAdmin());
  /** Show the tab strip only when BOTH tabs are available (a single-tab strip is just noise). */
  readonly showTabBar = computed(() => this.canUserTab() && this.canOpsTab());
  /** The tab actually rendered, clamped to what the user is allowed to see. */
  readonly effectiveTab = computed<'access' | 'ops'>(() => {
    const t = this.activeTab();
    if (t === 'ops' && !this.canOpsTab()) { return 'access'; }
    if (t === 'access' && !this.canUserTab()) { return 'ops'; }
    return t;
  });
  readonly refreshingUser = signal(false);
  readonly refreshingOps = signal(false);

  /** Switch tab AND reset the OTHER tab's transient state (loaded user, staged grants, validation)
   *  so each tab opens fresh. Landing on Manage access re-pulls the latest operator list. */
  selectTab(tab: 'access' | 'ops'): void {
    if (this.activeTab() === tab) { return; }
    this.resetUserTab();
    this.resetOpsTab();
    this.toast.set(null);
    this.activeTab.set(tab);
    if (tab === 'ops') { this.refreshOpsTab(); }
  }

  private resetUserTab(): void {
    this.uidInput.set('');
    this.lookup.set(null);
    this.grants.set([]);
    this.staged.set([]);
    this.copyFromUid.set('');
    this.sourceUser.set(null);
    this.sourceGrants.set([]);
    this.showSourceModal.set(false);
  }

  private resetOpsTab(): void {
    this.opsUidInput.set('');
    this.opsLookup.set(null);
    this.opsFilter.set('');
  }

  /** Refresh the User-access tab: re-pull the catalogue and, if a user is loaded, their grants. */
  refreshUserTab(): void {
    this.refreshingUser.set(true);
    this.svc.catalogue().subscribe({ next: (r) => this.catalogue.set(r.catalogue), error: () => { /* keep old */ } });
    this.loadAccessUsers();
    const lk = this.lookup();
    if (!lk?.active) { this.refreshingUser.set(false); return; }
    this.svc.loadUser(lk.username).subscribe({
      next: (r) => { this.refreshingUser.set(false); this.lookup.set(r.lookup); this.grants.set(r.lookup.active ? (r.grants ?? []) : []); },
      error: (e) => { this.refreshingUser.set(false); this.fail(e, 'Could not refresh the user'); }
    });
  }

  /** Refresh the Manage-access tab: re-pull the ops-admin list. */
  refreshOpsTab(): void {
    this.refreshingOps.set(true);
    this.svc.ops('list').subscribe({
      next: (r) => { this.refreshingOps.set(false); this.opsAdmins.set(r.ops_admins ?? []); },
      error: () => { this.refreshingOps.set(false); }
    });
  }

  /** (Re)load the "who has access" roster (all users with ≥1 grant). */
  loadAccessUsers(): void {
    this.loadingUsers.set(true);
    this.svc.usersWithAccess().subscribe({
      next: (r) => { this.loadingUsers.set(false); this.accessUsers.set(r.users ?? []); },
      error: () => { this.loadingUsers.set(false); }
    });
  }

  /** Set / toggle the roster sort column (same column flips asc↔desc). */
  sortUsers(key: 'name' | 'username' | 'email' | 'grants'): void {
    if (this.usersSortKey() === key) {
      this.usersSortDir.set(this.usersSortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.usersSortKey.set(key);
      this.usersSortDir.set('asc');
    }
    this.page.set(0);
  }

  /** Click a roster row → load that user into the editor above. */
  openUser(username: string): void {
    this.uidInput.set((username || '').toUpperCase());
    this.loadUser();
  }

  /** Download the (filtered + sorted) roster as a CSV file. */
  downloadUsers(): void {
    const rows = this.filteredUsers();
    if (!rows.length) { return; }
    const headers = ['Name', 'Username', 'Email', 'GUID', 'Features', 'Grants'];
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const u of rows) {
      lines.push([
        this.userFullName(u), u.username, u.email ?? '', u.guid ?? '',
        (u.features ?? []).join('; '), u.grant_count,
      ].map(esc).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `users-with-access-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Ops-admin gate --------------------------------------------------------
  readonly opsAdmins = signal<OpsAdmin[]>([]);
  readonly opsUidInput = signal('');
  readonly savingOps = signal(false);
  /** Candidate validated against OLS (shown for verification BEFORE Add is allowed). */
  readonly opsLookup = signal<UserLookup | null>(null);
  readonly opsValidating = signal(false);
  /** Free-text filter over the ops-admin list (username / name / email). */
  readonly opsFilter = signal('');
  readonly filteredOps = computed(() => {
    const q = this.opsFilter().trim().toLowerCase();
    const list = this.opsAdmins();
    if (!q) { return list; }
    return list.filter((o) =>
      o.username.toLowerCase().includes(q) ||
      (o.display_name ?? '').toLowerCase().includes(q) ||
      (o.email ?? '').toLowerCase().includes(q));
  });
  /** The existing ops-admin row matching the validated candidate (case-insensitive), if any —
   *  so we can block a duplicate add and tell the user they're already an ops-admin. */
  readonly opsExisting = computed<OpsAdmin | null>(() => {
    const lk = this.opsLookup();
    if (!lk?.active) { return null; }
    const u = lk.username.trim().toUpperCase();
    return this.opsAdmins().find((o) => o.username.trim().toUpperCase() === u) ?? null;
  });
  /** Add is enabled only once the typed uid is validated AND is not already an ops-admin. */
  readonly canAddOps = computed(() => !!this.opsLookup()?.active && !this.opsExisting());

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
    this.loadAccessUsers();
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
    const uid = this.uidInput().trim().toUpperCase();
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
    // Access is env-independent — there is no per-grant environment.
    return { username, resource_type, resource_scope, resource_key, access_level: level };
  }

  /** Pick a level from the segmented control (ignores levels invalid for the current kind). */
  setLevel(lv: Level): void {
    if (this.allowedLevels().includes(lv)) { this.level.set(lv); }
  }

  private sameKey(a: GrantRow, b: GrantRow): boolean {
    return a.resource_type === b.resource_type && a.resource_scope === b.resource_scope &&
      (a.resource_key || '').toUpperCase() === (b.resource_key || '').toUpperCase();
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
    this.copyFromUid.set(v.toUpperCase());
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
        this.loadAccessUsers();   // roster grant-counts / features may have changed
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
        this.loadAccessUsers();   // roster grant-counts / features may have changed
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

  /** Editing the ops uid invalidates a prior validation, so Add disables until re-validated. */
  onOpsUidChange(v: string): void {
    this.opsUidInput.set(v.toUpperCase());
    if (this.opsLookup()) { this.opsLookup.set(null); }
  }

  /** Look the candidate up in OLS and show their details for verification BEFORE adding. */
  validateOps(): void {
    const uid = this.opsUidInput().trim().toUpperCase();
    if (!uid) { return; }
    this.opsValidating.set(true);
    this.opsLookup.set(null);
    this.toast.set(null);
    this.svc.loadUser(uid).subscribe({
      next: (r) => {
        this.opsValidating.set(false);
        this.opsLookup.set(r.lookup);
        if (!r.lookup.active) {
          this.toast.set({ kind: 'err', text: r.lookup.message || `The ${uid} user is not active in OLS.` });
        }
      },
      error: (e) => { this.opsValidating.set(false); this.fail(e, 'Could not validate the user'); }
    });
  }

  /** Add the (already-validated, active) candidate as an ops-admin. */
  async addOps(): Promise<void> {
    const lk = this.opsLookup();
    if (!lk || !lk.active) { return; }
    const existing = this.opsExisting();
    if (existing) {
      this.toast.set({ kind: 'err', text: existing.is_active === 'Y'
        ? `${lk.username} is already an ops-admin.`
        : `${lk.username} already exists as an ops-admin but is disabled — enable them from the list below.` });
      return;
    }
    const uid = lk.username.trim();
    const ok = await this.confirm.ask({
      title: 'Add ops-admin',
      message: `Give ${lk.display_name || uid} (${uid}) access to User Management? They will be able to grant access to any OLS user.`,
      confirmLabel: 'Add', tone: 'primary'
    });
    if (!ok) { return; }
    this.savingOps.set(true);
    this.svc.ops('add', uid).subscribe({
      next: (r) => {
        this.savingOps.set(false);
        this.opsAdmins.set(r.ops_admins ?? []);
        this.opsUidInput.set('');
        this.opsLookup.set(null);
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
    if (o.is_active !== 'Y') { return; }   // no privilege changes on a disabled user — enable them first
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
    if (o.is_active !== 'Y') { return; }   // no privilege changes on a disabled user — enable them first
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

  /** "First Surname" when both are known, else the display name, else the uid. */
  userFullName(u: { first_name?: string; surname?: string; display_name?: string; username: string }): string {
    const full = [u.first_name, u.surname].filter(Boolean).join(' ').trim();
    return full || u.display_name || u.username;
  }

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
