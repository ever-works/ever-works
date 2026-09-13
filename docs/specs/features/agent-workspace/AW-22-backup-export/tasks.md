# AW-22 — Backup and export the workspace · Task List

**Epic:** `AW-22-backup-export` · **Program:** [Agent Workspace](../README.md)
**Spec:** [spec.md](./spec.md) · **Plan:** [plan.md](./plan.md) · **Date:** 2026-09-06

Execute top to bottom. Every task names the files it creates or modifies, what "done" means, and
its phase. Tasks inside a phase are ordered so that each one compiles against the ones before it.

**Before starting:** `git fetch origin && git checkout -b feat/aw-22-workspace-backup origin/develop`.
Run `pnpm install` after any `package.json` change.

---

## Phase 1 — A complete archive you can download

Ships spec FR-1 to FR-33 and FR-41 to FR-47. Leaves `develop` green: everything is new except two
additive render calls, and the existing export/import/sync path is untouched.

### T-01 · Contracts: the backup format module

**Phase:** P1
**Create:** `packages/contracts/src/backup/format.ts`, `packages/contracts/src/backup/index.ts`
**Modify:** `packages/contracts/src/index.ts` (add `export * from './backup/index.js';`)

Implement exactly the shapes in [plan.md §3.2](./plan.md#32-new-contract-module-types-only-no-schema):
`BACKUP_FORMAT_VERSION`, `BackupDomainKey` (the fifteen keys), `BackupDomainStatus`,
`BackupRestorability`, `BackupOmissionReason`, `BackupManifest`, `BackupDomainReport`,
`BackupOmission`, `BackupExclusion`, `BackupCheckReport`, and the frozen `BACKUP_DOMAINS` array
pairing each key with its restorability class, its collector id, its default trim field and its
default and full-history windows (spec FR-14).

Types only — no runtime dependency on TypeORM, NestJS or Node built-ins, because this module is
imported by `apps/web`.

**Done when:** `cd packages/contracts && pnpm build` emits declarations, and
`import { BACKUP_DOMAINS } from '@ever-works/contracts'` resolves from both `apps/web` and
`packages/agent`.

---

### T-02 · Contracts: barrel and format specs

**Phase:** P1
**Create:** `packages/contracts/src/__tests__/backup-format.spec.ts`
**Modify:** `packages/contracts/src/__tests__/index.barrel.spec.ts` (add the `backup` area to the
`AREAS` array and its `import * as backup` line)

Assert: `BACKUP_DOMAINS.length === 15`; every key is unique; every entry has a restorability
class and a collector id; every entry with a trim window has a trim field; the default window is
never larger than the full-history window; `BACKUP_FORMAT_VERSION` matches `/^\d+\.\d+$/`.

**Done when:** `cd packages/contracts && pnpm test` passes, including the ambiguous-re-export
guard in `index.barrel.spec.ts`.

---

### T-03 · Entity: `WorkspaceBackup`

**Phase:** P1
**Create:** `packages/agent/src/entities/workspace-backup.entity.ts`

`@Entity('workspace_backups')` with exactly the columns, types and nullability of
[plan.md §3.1](./plan.md#31-new-entity--workspacebackup). Use `simple-json` for
`manifestSummary`. Declare `idx_workspace_backups_scope` and `idx_workspace_backups_sweep` with
`@Index`; do **not** declare the partial unique index at decorator level — it is created in the
migration as raw SQL so TypeORM's SQLite test driver cannot synthesise a non-partial duplicate
(the same reasoning `work_budgets` records). Say that in the doc comment, and name spec FR-3,
FR-5, FR-28 and FR-29 there.

**Done when:** `cd packages/agent && pnpm type-check` passes.

---

### T-04 · Entity registration (three files — a drift spec fails CI if any is missed)

**Phase:** P1
**Modify:**
- `packages/agent/src/entities/index.ts` — `export * from './workspace-backup.entity';`
- `packages/agent/src/database/_entity-names.ts` — add `'WorkspaceBackup'` in alphabetical order
- `packages/agent/src/database/_entities-inventory.ts` — import the class and add it to `ENTITIES`

**Done when:** `cd packages/agent && npx jest --testPathPattern='database' ` passes, including the
entity-count drift assertions.

---

### T-05 · Repository

**Phase:** P1
**Create:** `packages/agent/src/database/repositories/workspace-backup.repository.ts`
**Modify:** `packages/agent/src/database/_repository-inventory.ts` (import + entry in
`REPOSITORY_PROVIDERS`, alphabetical), `packages/agent/src/database/index.ts` (barrel line)

Methods:

- `findActive(scope): Promise<WorkspaceBackup | null>` — status in `queued`/`running`
- `listForScope(scope, { limit, cursor }): Promise<{ rows; nextCursor }>` — newest first, limit
  capped at 50
- `countReadyInWindow(scope, since: Date): Promise<number>` — the FR-4 allowance; counts only
  `ready` and `ready_with_gaps`
- `createQueued(scope, opts): Promise<WorkspaceBackup>` — must surface a unique-violation as a
  typed conflict so the service can adopt the running row instead of throwing (spec S-9)
- `claimForRun(id): Promise<boolean>` — compare-and-set `queued` → `running`
- `heartbeat(id, patch): Promise<void>`
- `markTerminal(id, patch): Promise<void>` — compare-and-set away from `running`
- `requestCancel(id): Promise<boolean>` — compare-and-set to `cancelled` from `queued`/`running`
- `findExpirable(now, limit)`, `findStalled(now, limit)`, `findPrunable(now, limit)` — the three
  sweeper passes

**Done when:** `REPOSITORY_PROVIDERS.length` assertions in `database.module.spec.ts` pass and the
repository imports cleanly from `@ever-works/agent/database`.

---

### T-06 · Migration (same PR as T-03 — Constitution V)

**Phase:** P1
**Create:** `apps/api/src/migrations/1791220000000-CreateWorkspaceBackups.ts`

Follow [plan.md §3.3](./plan.md#33-migration-constitution-v--same-pr-as-31). Portable
`Table`/`TableColumn` DDL with `ifNotExists`; FK `userId → users(id) ON DELETE CASCADE`; the two
plain indexes; the partial unique index via `queryRunner.query(...)` guarded on
`queryRunner.connection.options.type === 'postgres'`; `down()` drops only `workspace_backups`.
Model the file header and guard style on
`apps/api/src/migrations/1789100000000-AddTaskGraphFanout.ts`.

**Before merge:** the timestamp is AW-22's reserved slot 00 ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)). Rebase on
`develop`; if a migration with a higher timestamp has landed, re-stamp the filename **and** the class name.

**Done when:** `cd apps/api && pnpm typeorm migration:run -d typeorm.config.ts` applies cleanly to
a fresh database, a second run is a no-op, `migration:revert` drops only the new table, and the
better-sqlite3 test path also applies it.

---

### T-07 · Redaction module

**Phase:** P1
**Create:** `packages/agent/src/account-transfer/backup/redaction.ts`

Implement the three rule families in
[plan.md §3.6](./plan.md#36-redaction-rules-the-collectors-enforce): `redactRow(entityName, row)`
returns the row with secret-bearing columns replaced by `{ wasSet: boolean }`, named columns
deleted, and a `shouldDropEntirely(entityName)` predicate for the nine never-exported tables.
Export `BACKUP_EXCLUSIONS`, the nine categories of spec FR-18, so the manifest builder and the
coverage drawer render the same list.

**Done when:** `cd packages/agent && pnpm type-check` passes.

---

### T-08 · Redaction CI guard

**Phase:** P1
**Create:** `packages/agent/src/account-transfer/backup/redaction.spec.ts`

Two halves:
1. Fixture rows for `Work`, `UserPlugin`, `McpServerConnection`, `InboundTrigger`,
   `WebhookSubscription`, `FleetNode`, `User`, `ApiKey`, `BillingProfile`,
   `TenantJobRuntimeConfig` — assert no secret value survives and that the field **name** does.
2. A reflection pass over `AGENT_ENTITY_NAMES` that fails when an entity carries a column matching
   `/secret|password|token|hash|credential/i` that no rule in T-07 covers.

**Done when:** `cd packages/agent && npx jest --testPathPattern='redaction'` passes, and
temporarily adding a fake `fooSecretEncrypted` column to a fixture entity makes it fail.

---

### T-09 · Archive writer

**Phase:** P1
**Create:** `packages/agent/src/account-transfer/backup/backup-archive-writer.ts`
**Modify:** `packages/agent/package.json` (add a streaming zip encoder dependency; do **not**
reuse `jszip`, which buffers the whole archive — see [plan.md §7](./plan.md#7-plugin-boundaries))

Responsibilities:
- Open a zip stream and expose `addJsonlEntry(path, asyncIterable)`, `addFileEntry(path, stream,
  size)` and `addTextEntry(path, string)`.
- Maintain a running SHA-256 per entry and for the archive, and running byte counters for the
  attachment budget (2 GiB) and the archive ceiling (5 GiB, or 512 MiB with a non-streaming
  backend) — spec FR-15, FR-16.
- Serialise JSONL with stable key order and LF terminators; sort each entry's rows by
  `createdAt` then `id` (spec FR-22).
- Emit `checksums.txt` last, covering every entry except itself (spec FR-25).
- Abort cleanly on cancellation, destroying the stream so no partial object is left.

**Done when:** `pnpm type-check` passes and the writer can be driven by a unit test without a
database.

---

### T-10 · Manifest and README builders

**Phase:** P1
**Create:** `packages/agent/src/account-transfer/backup/backup-manifest.ts`,
`packages/agent/src/account-transfer/backup/backup-readme.ts`

`buildManifest(...)` produces a `BackupManifest` (T-01) with all fifteen domains present, each
carrying status, restorability, record and file counts, per-file checksums, trim cutoffs and
error codes, plus the omissions list and `BACKUP_EXCLUSIONS` (spec FR-24).
`buildReadme(manifest)` produces the under-400-word plain-language `README.md` of spec FR-26 —
what this is, when it was taken, what each folder holds, what is never included, what can be
restored, how long our copy lasts, where the field reference lives. English only; it is a file
inside the archive, not interface copy.

**Done when:** `pnpm type-check` passes and `buildReadme` output is under 400 words for a fixture
manifest (asserted in T-19).

---

### T-11 · Domain collectors, part 1 — account, organizations, agents

**Phase:** P1
**Create:**
- `packages/agent/src/account-transfer/backup/collectors/collector.types.ts` — the
  `BackupCollector` interface: `key`, `collect(ctx): AsyncIterable<{ file, row }>`, `pageSize`
- `packages/agent/src/account-transfer/backup/collectors/account.collector.ts`
- `packages/agent/src/account-transfer/backup/collectors/organizations.collector.ts`
- `packages/agent/src/account-transfer/backup/collectors/agents.collector.ts`

Each collector pages its repositories (default page size 500), applies `redactRow` from T-07, and
yields `{ file, row }` pairs matching the layout in
[plan.md §3.5](./plan.md#35-the-archive-layout-on-disk). Never load a whole table into memory.
Scope every query by `userId` plus the active `organizationId` (or `IS NULL`), per spec FR-9.

**Done when:** `pnpm type-check` passes and each collector yields rows against fixture
repositories in T-18.

---

### T-12 · Domain collectors, part 2 — missions, tasks, works, knowledge, schedules

**Phase:** P1
**Create:**
- `.../collectors/missions.collector.ts`
- `.../collectors/tasks.collector.ts`
- `.../collectors/works.collector.ts`
- `.../collectors/knowledge.collector.ts`
- `.../collectors/schedules.collector.ts`

`works.collector.ts` reuses the existing per-Work content walk in
`packages/agent/src/account-transfer/account-export.service.ts` for `data/works/content/<slug>/`
so there is exactly one implementation of "read a Work's items out of its data repo"
(Constitution III). `knowledge.collector.ts` also enqueues each upload's storage key onto the
runner's file queue so T-13 can copy the bytes.

**Done when:** `pnpm type-check` passes and `works.collector.ts` contains no second copy of the
data-repo read.

---

### T-13 · Domain collectors, part 3 — runs, decisions, communication, connections, fleet, billing, activity

**Phase:** P1
**Create:**
- `.../collectors/runs.collector.ts`
- `.../collectors/decisions.collector.ts`
- `.../collectors/communication.collector.ts`
- `.../collectors/connections.collector.ts`
- `.../collectors/fleet.collector.ts`
- `.../collectors/billing.collector.ts`
- `.../collectors/activity.collector.ts`
- `.../collectors/index.ts` — the registry mapping every `BackupDomainKey` to its collector

Every collector in this group applies the trim window from `BACKUP_DOMAINS` (spec FR-14) and
reports the cutoff and the omitted count so the manifest can record it.
`fleet.collector.ts` exports node inventory metadata only — never `enrollmentTokenHash`.
`billing.collector.ts` exports ledger and invoice rows but no provider identifier.

**Done when:** `pnpm type-check` passes and `collectors/index.ts` has an entry for all fifteen
`BackupDomainKey` values, asserted by T-18.

---

### T-14 · Storage contract: optional streaming methods

**Phase:** P1
**Modify:** `packages/plugin/src/contracts/capabilities/storage.interface.ts`

Add `StoragePutStreamInput`, `putObjectStream?`, and `getObjectStream?` exactly as described in
[plan.md §7](./plan.md#7-plugin-boundaries). Both **optional**, so no existing plugin breaks and
no plugin major version is needed (Constitution X). Document the two new capability names
`put-object-stream` and `get-object-stream` in the interface doc comment.

**Done when:** `cd packages/plugin && pnpm build && pnpm test` passes with no change to any
existing implementation.

---

### T-15 · Storage plugins: implement streaming where the backend supports it

**Phase:** P1
**Modify:** `packages/plugins/local-fs/`, `packages/plugins/aws-s3/`, `packages/plugins/minio/`
(implementation plus the `capabilities` array in each `package.json`'s `everworks.plugin` block)
**Modify:** `docs/plugin-system/built-in-plugins.md` — record the two new capabilities there and
nowhere else (Constitution VIII)

`local-fs`: pipe to a temporary path then rename. `aws-s3` / `minio`: multipart upload.
`github-storage` is deliberately **not** changed — its blob API is not a streaming target, and the
runner degrades to the 512 MiB ceiling for it.

**Done when:** each touched plugin's `pnpm test` passes, and a new test in each asserts a
round-trip of a stream larger than the plugin's internal chunk size.

---

### T-16 · Backup storage accessor

**Phase:** P1
**Create:** `packages/agent/src/account-transfer/backup/backup-storage.ts`
**Modify:** `apps/api/src/account/account.module.ts` (bind the token to
`getActiveStorageBackend()` from `apps/api/src/uploads/storage-backend.factory.ts`)

A `BACKUP_STORAGE` DI token plus a thin accessor exposing `putArchive(stream, meta)`,
`getArchiveStream(key)`, `deleteArchive(key)` and `supportsStreaming(): boolean`. Resolve by
**capability probe** (`typeof plugin.putObjectStream === 'function'`), never by backend id
(Constitution II). Use the token-plus-type-only-import pattern that
`apps/api/src/uploads/uploads.service.ts` uses, so the agent package does not pull the API module
into its import graph.

**Done when:** `pnpm type-check` passes in both packages and no string literal naming a storage
backend appears in `packages/agent/src/account-transfer/backup/`.

---

### T-17 · Runner

**Phase:** P1
**Create:** `packages/agent/src/account-transfer/backup/workspace-backup-runner.ts`

Orchestrates one backup: claim the row, open the writer, walk `BACKUP_DOMAINS` in order, run each
collector inside its own try/catch with **2 retries** before marking the domain `failed` (spec
FR-17), copy queued file bytes until the attachment budget is reached (spec FR-15), write
`manifest.json`, `README.md` and `checksums.txt`, upload through T-16, then mark the row `ready`
or `ready_with_gaps` with size, checksum, counts, `manifestSummary` and `expiresAt`.

Also: heartbeat after every domain and at least every 30 s inside one (spec FR-5); check for
cancellation between domains and between pages; abort with `too_large` when the archive ceiling
is crossed (spec FR-16); on any storage error retry 3 times with backoff then fail with
`storage_unavailable` (spec S-23).

**Done when:** `pnpm type-check` passes.

---

### T-18 · Runner and collector unit specs

**Phase:** P1
**Create:**
- `packages/agent/src/account-transfer/backup/workspace-backup-runner.spec.ts`
- `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts`

Assert: all fifteen domains are walked and appear in the manifest; a collector that throws twice
is marked `failed` while the other fourteen complete and the archive still finishes (spec FR-17);
heartbeats are written; a cancellation between pages aborts and deletes the partial object; trim
windows are applied and recorded; the collector registry covers every `BackupDomainKey`; queries
never cross a workspace scope.

**Done when:** `cd packages/agent && npx jest --testPathPattern='backup'` passes.

---

### T-19 · Archive-writer and manifest unit specs

**Phase:** P1
**Create:**
- `packages/agent/src/account-transfer/backup/backup-archive-writer.spec.ts`
- `packages/agent/src/account-transfer/backup/backup-manifest.spec.ts`

Assert: the zip's top level is exactly `manifest.json`, `README.md`, `checksums.txt`, `data/`,
`files/` (spec FR-21); each JSONL file's line count equals its manifest record count (spec
FR-22); every `checksums.txt` entry verifies; a 250 MiB fixture file is omitted with
`size_limit` while its metadata row survives (spec FR-15); crossing the archive ceiling aborts
with `too_large` (spec FR-16); two runs over identical fixtures differ only in timestamps and
identifiers; the manifest lists all fifteen domains and all nine exclusion categories; the README
is under 400 words.

**Done when:** `cd packages/agent && npx jest --testPathPattern='backup'` passes.

---

### T-20 · Lifecycle service

**Phase:** P1
**Create:** `packages/agent/src/account-transfer/backup/workspace-backup.service.ts`

Owns everything the controller calls: `create` (adopt on conflict, enforce the 3-per-24h
allowance counting only ready outcomes, refuse with `retryAt`, return `503` semantics when
storage is unconfigured), `list`, `get`, `getCurrent`, `cancel`, `deleteArtifact`,
`mintDownloadToken` / `verifyDownloadToken` (HMAC over backup id + user id + scope + expiry, 15
minutes), and `expire`. Also writes the activity entry and raises the single notification per
finished backup (spec FR-32, FR-33) via `ActivityLogService.log` and `NotificationService.create`
with category `SYSTEM`.

**Done when:** `pnpm type-check` passes.

---

### T-21 · Lifecycle service spec

**Phase:** P1
**Create:** `packages/agent/src/account-transfer/backup/workspace-backup.service.spec.ts`

Assert: a second create adopts the running row rather than inserting (spec FR-3); the fourth ready
backup in 24 h is refused with a `retryAt` and failures do not count (spec FR-4); cancel is a
compare-and-set that is a no-op on a terminal row; a token for backup A cannot download backup B
and a token minted for user A is rejected for user B; an expired token is rejected; exactly one
notification and one activity entry are produced per finished backup.

**Done when:** `cd packages/agent && npx jest --testPathPattern='workspace-backup.service'` passes.

---

### T-22 · Dispatcher symbol

**Phase:** P1
**Create:** `packages/agent/src/tasks/workspace-backup-dispatcher.ts`,
`packages/agent/src/tasks/workspace-backup.types.ts`
**Modify:** `packages/agent/src/tasks/index.ts` (export lines),
`packages/agent/src/tasks/_tasks-symbols.ts` (add `'WORKSPACE_BACKUP_DISPATCHER'` in alphabetical
position), `packages/agent/src/tasks/job-runtime.providers.ts` (import + bind through
`JOB_RUNTIME_PROVIDER_REGISTRY`)

Copy the shape of `packages/agent/src/tasks/kb-embed-document-dispatcher.ts` exactly: payload type,
one-method interface returning `Promise<string | null>`, `Symbol(...)` token, and a doc comment
that says what a `null` return means for the caller.

**Done when:** `cd packages/agent && npx jest --testPathPattern='tasks'` passes — in particular
the barrel symbol-set assertion in `tasks.spec.ts`.

---

### T-23 · Producer method on the runtime service

**Phase:** P1
**Modify:** `packages/tasks/src/trigger/trigger.service.ts`

Add `dispatchWorkspaceBackup(payload)` guarded by `ensureConfigured()`, returning the run handle
id or `null`, matching `dispatchKbEmbedDocument` line for line in structure and error handling.

**Done when:** `cd packages/tasks && pnpm type-check` passes.

---

### T-24 · Archive task

**Phase:** P1
**Create:** `packages/tasks/src/tasks/trigger/workspace-backup.task.ts`
**Modify:** `packages/tasks/src/tasks/trigger/index.ts`

`task<'workspace-backup', WorkspaceBackupPayload>` with `maxDuration: 3600` (spec FR-6),
`retry.maxAttempts: 1`, a per-workspace concurrency key and a global `concurrencyLimit: 2`. Use
`withWorkerContext` and the plugin-hydrator/tenant-binding services exactly as
`kb-embed-document.task.ts` does. Skip-and-ack (never throw) for `backup-not-found`,
`already-terminal` and `cancelled`; throw only on genuine infrastructure failures.

**Done when:** `cd packages/tasks && pnpm build` passes and the task id appears in the barrel.

---

### T-25 · Sweeper cron task

**Phase:** P1
**Create:** `packages/tasks/src/tasks/trigger/workspace-backup-sweeper.task.ts`
**Modify:** `packages/tasks/src/tasks/trigger/index.ts`

`schedules.task` at `17 * * * *`, modelled on
`packages/tasks/src/tasks/trigger/terminal-transcript-gc.task.ts`. Three idempotent passes under
`DistributedTaskLockService`: expire artefacts past `expiresAt` (spec FR-28), fail rows stalled
for 10 minutes or queued for 15 (spec FR-5), prune records terminal for more than 90 days (spec
FR-29). Each pass batches at 200 rows and logs its counts.

**Done when:** `cd packages/tasks && pnpm build` passes.

---

### T-26 · Module wiring

**Phase:** P1
**Modify:** `packages/agent/src/account-transfer/account-transfer.module.ts` (providers + exports
for the runner, the writer, the service, the storage accessor and every collector),
`packages/agent/src/account-transfer/index.ts` (barrel lines),
`apps/api/src/account/account.module.ts` (declare the new controller; bind `BACKUP_STORAGE`)

Nothing already provided or exported there is removed or re-ordered.

**Done when:** `cd packages/agent && npx jest --testPathPattern='account-transfer.module'` passes
and the API boots.

---

### T-27 · Request and response DTOs

**Phase:** P1
**Create:** `apps/api/src/account/dto/create-backup.dto.ts`,
`apps/api/src/account/dto/verify-manifest.dto.ts`, `apps/api/src/account/dto/backup.dto.ts`

class-validator classes so the global `ValidationPipe` actually applies — unlike the existing
export/import bodies, whose hand-rolled caps in `apps/api/src/account/account.controller.ts` exist
precisely because their types are erased interfaces. `BackupDto` uses `@Exclude()` on
`storageKey`, `failureDetail`, `runtimeRunId` and `credentialVersion`.

**Done when:** `cd apps/api && pnpm type-check` passes.

---

### T-28 · Controller

**Phase:** P1
**Create:** `apps/api/src/account/workspace-backup.controller.ts`

`@Controller('api/account/backups')` implementing routes 1–10 of
[plan.md §4](./plan.md#4-api-surface). Session-guarded, scope-resolved through
`ScopeContextService`, plus an owner-only check that returns `403` with a stable code for a
non-owner member (spec FR-10). `POST /` returns `202`; the download route streams from
`getArchiveStream` and never buffers; the verify route caps the body at 8 MiB.

**Done when:** `cd apps/api && pnpm type-check` passes and the routes appear in the boot log.

---

### T-29 · Controller spec

**Phase:** P1
**Create:** `apps/api/src/account/workspace-backup.controller.spec.ts`

Cover every route: `202` on create; `200 { adopted: true }` while one runs; `429` with `retryAt`
over the allowance; `503` with no storage configured; `403` for a non-owner; `404` cross-scope;
`410` on an expired archive; `403` on a bad or stale token; `422 not_a_backup_manifest` naming
both sentinel fields; `422 format_too_new`; and that no `BackupDto` response body contains
`storageKey`, `failureDetail`, `runtimeRunId` or `credentialVersion`.

**Done when:** `cd apps/api && pnpm test` passes.

---

### T-30 · Legacy-path regression assertion

**Phase:** P1
**Modify:** `apps/api/src/account/account.controller.spec.ts`

Add one test asserting `GET /api/account/export` still returns the same shape and the same
`Content-Disposition` header it does today. This is the guard for program rule #1.

**Done when:** `cd apps/api && pnpm test` passes.

---

### T-31 · Web API client

**Phase:** P1
**Create:** `apps/web/src/lib/api/workspace-backup.ts`,
`apps/web/src/lib/api/workspace-backup.types.ts`

Typed wrappers for routes 1–10, modelled on `apps/web/src/lib/api/account-transfer.ts`. Re-export
`BackupDomainKey`, `BackupManifest` and `BackupCheckReport` from `@ever-works/contracts` rather
than redeclaring them.

**Done when:** `cd apps/web && pnpm type-check` passes.

---

### T-32 · Server actions

**Phase:** P1
**Create:** `apps/web/src/app/actions/workspace-backup.ts`

`'use server'` actions `createBackup`, `cancelBackup`, `deleteBackup`, `mintDownloadLink`,
`verifyManifest`, each `ensureAuth()`-guarded and Zod-validated, returning the
`{ success, data, error }` envelope used by `apps/web/src/app/actions/account-transfer.ts`.
`verifyManifest` rejects a payload over 8 MiB before any network call.

**Done when:** `cd apps/web && pnpm type-check` passes.

---

### T-33 · Polling hook

**Phase:** P1
**Create:** `apps/web/src/components/settings/useWorkspaceBackup.ts`

Fetches `current` and `list` in parallel on mount; polls `current` only while `queued`/`running`,
at 5 s for the first 5 minutes then 15 s (spec FR-41); stops on `visibilitychange` → hidden and
refetches immediately on show; exposes `status`, `progress`, `history`, the mutation callbacks and
a 30 s-throttled live-region string (spec FR-42).

**Done when:** `cd apps/web && pnpm type-check` passes.

---

### T-34 · The card

**Phase:** P1
**Create:** `apps/web/src/components/settings/WorkspaceBackupCard.tsx`

All eleven states of [spec §6](./spec.md#6-ux) — loading skeleton with **no** Create button,
none-yet, options open, running with cancel, ready, ready-with-omissions, section-incomplete,
failed, rate-limited, unavailable, not-owner. Every string from a message key (T-40). Real
`<button>` elements, visible focus, and a live region wrapping the progress text.

**Done when:** `cd apps/web && pnpm type-check` passes and each state can be forced from the unit
spec in T-43.

---

### T-35 · History list

**Phase:** P1
**Create:** `apps/web/src/components/settings/WorkspaceBackupHistory.tsx`

Up to 20 rows (spec FR-30) with date, size, coverage and either Download, `Expired {date}` or a
failure reason. Arrow-key navigation between rows, `Enter` opens that row's coverage drawer, and a
`Show all` control when more exist.

**Done when:** `pnpm type-check` passes.

---

### T-36 · Coverage drawer

**Phase:** P1
**Create:** `apps/web/src/components/settings/WorkspaceBackupCoverageDrawer.tsx`

Renders `manifestSummary` as the table in [spec §6.7](./spec.md#67-whats-inside--the-coverage-drawer):
fifteen rows with records, status and restorability, trim notes indented under their domain, the
files included/omitted line, the never-included line built from `BACKUP_EXCLUSIONS`, and a link to
the format reference. Focus is trapped, `Esc` closes and focus returns to the trigger.

**Done when:** `pnpm type-check` passes.

---

### T-37 · Danger-zone banner

**Phase:** P1
**Create:** `apps/web/src/components/settings/LastBackupBanner.tsx`
**Modify:** `apps/web/src/components/settings/DangerZone.tsx` (render the banner at the top;
change nothing else)

Shows the last completed backup's relative time, size and coverage, or the never-taken copy, plus
a link to `/settings/data` (`ROUTES.DASHBOARD_SETTINGS_DATA`, already defined in
`apps/web/src/lib/constants.ts`).

**Done when:** `pnpm type-check` passes and the existing danger-zone e2e in
`apps/web/e2e/account-data.spec.ts` still passes unchanged.

---

### T-38 · Mount the card

**Phase:** P1
**Modify:** `apps/web/src/components/settings/DataManagement.tsx`

Render `<WorkspaceBackupCard />` above the existing export card. Do not touch, reorder or reword
the existing export, import or sync sections — this is the one place program rule #1 is easiest to
break.

**Done when:** `/settings/data` renders the new card first and the existing three sections
unchanged below it.

---

### T-39 · BFF download route

**Phase:** P1
**Create:** `apps/web/src/app/api/account/backups/[id]/download/route.ts`

Copy `apps/web/src/app/api/credits/usage/export/route.ts`: forward the auth cookie as a Bearer
token, allowlist exactly `token` as a forwarded query param, consume the `?scope=` selector with
`applyBffWorkspaceScopeFromNavigation` from `@/lib/api/bff-scope` (an `<a download>` cannot send
`x-ever-workspace`), pipe `response.body` straight through, and fall back to a **constant**
`Content-Disposition` rather than echoing a caller-controlled value.

**Done when:** `pnpm type-check` passes and a download of a fixture archive streams end to end.

---

### T-40 · i18n — English

**Phase:** P1
**Modify:** `apps/web/messages/en.json`

Add every key in [plan.md §8](./plan.md#8-i18n) under `dashboard.settings.data.backup`, plus
`notifications.backupReady` / `backupPartial` / `backupFailed`,
`dashboard.dangerZone.backupBanner.*` and `metadata.pages.workspaceBackup`. Copy comes verbatim
from [spec §6.11](./spec.md#611-exact-user-visible-copy). **Leaf key names are camelCase and must
never contain a literal `.`** — a dotted leaf is rejected at runtime and reds several e2e shards
at once. Numbers travel as interpolation params, never baked into English strings.

**Done when:** `cd apps/web && pnpm type-check` passes and no component renders a raw key.

---

### T-41 · i18n — the other 20 locales

**Phase:** P1
**Modify:** the 20 sibling files in `apps/web/messages/`

Run the existing parity-sync script so every locale gets the full new subtree seeded from
English. A missing **parent** key collapses the whole subtree for that locale, so this must land
in the same change as T-40.

**Done when:** the i18n parity check passes in CI.

---

### T-42 · Web unit spec — the card

**Phase:** P1
**Create:** `apps/web/src/components/settings/WorkspaceBackupCard.unit.spec.tsx`

One case per state, asserting the exact §6.11 copy, that the loading state renders no Create
button, that disabled controls carry their reason as accessible text, and that the delete flow
requires a second confirmation.

**Done when:** `cd apps/web && npx vitest run src/components/settings/WorkspaceBackupCard.unit.spec.tsx`
passes.

---

### T-43 · Web unit spec — the hook and the download route

**Phase:** P1
**Create:** `apps/web/src/components/settings/useWorkspaceBackup.unit.spec.ts`,
`apps/web/src/app/api/account/backups/[id]/download/route.unit.spec.ts`

Hook: 5 s → 15 s backoff at the five-minute mark; polling stops when hidden and refetches on show;
the live-region string is throttled to 30 s; a terminal status stops polling entirely.
Route: only `token` is forwarded upstream; the `scope` carrier is consumed rather than relayed; the
body is piped, not awaited; the fallback disposition is a constant.

**Done when:** both specs pass under `cd apps/web && pnpm test`.

---

### T-44 · E2E — the golden path

**Phase:** P1
**Create:** `apps/web/e2e/workspace-backup.spec.ts`

Create → running → ready; the coverage drawer lists fifteen sections; download returns
`application/zip` with a `Content-Disposition` filename matching spec FR-20; a second create
adopts the first; a non-owner member sees both controls disabled with the reason; the danger-zone
banner reflects the last backup.

**Done when:** `cd apps/web && npx playwright test e2e/workspace-backup.spec.ts` passes locally and
in CI.

---

### T-45 · Documentation

**Phase:** P1
**Create:** `docs/features/workspace-backup.md`
**Modify:** `apps/docs/sidebarsPlatform.ts` (add the page — the sidebar is manual; an unlisted
file renders only as an orphan), `docs/features/data-management.md` (one paragraph pointing at
the new page and saying which job each surface does)

The page is the published field reference of spec FR-24 and FR-27: the archive layout, the
manifest fields, the fifteen domains and their restorability, the trim windows, the nine
exclusion categories, the retention and allowance defaults, and the version policy. Generate the
domain table from `BACKUP_DOMAINS` rather than hand-maintaining it.

**Done when:** `cd apps/docs && pnpm build` succeeds and the page appears in the sidebar.

---

### T-46 · Program bookkeeping

**Phase:** P1
**Modify:** `docs/specs/features/agent-workspace/README.md` (add *Workspace backup* to the
vocabulary table in §1, per program rule #2),
`docs/specs/features/agent-workspace/TRACKER.md` (AW-22 spec + P1 status, and the capabilities
this phase delivered). TRACKER.md is the program's only progress record — do not create another.

**Done when:** the vocabulary table names the one new noun this epic introduces and the tracker
reflects the phase that shipped.

---

### T-47 · Phase 1 gate

**Phase:** P1

Run, from the repo root: `pnpm lint`, `pnpm type-check`, `pnpm test`, then
`cd apps/web && npx playwright test e2e/account-data.spec.ts e2e/workspace-backup.spec.ts`.
Then walk the spec §8 acceptance checklist under **Producing**, **Coverage**, **Never included**,
**Shape**, **Retention and record**, **Permission and scope** and **Interface**, ticking each.

**Done when:** every command is green, every checked item passes on a real deployment, and a
`grep` of a produced archive for a known plugin API key, a session token, a password hash, a node
enrolment secret and a payment identifier returns nothing (spec FR-18).

---

## Phase 2 — Check it, and restore what can be restored

Ships spec FR-34 to FR-40.

### T-48 · Verify service

**Phase:** P2
**Create:** `packages/agent/src/account-transfer/backup/backup-verify.service.ts`

`verifyManifest(manifest)` → `BackupCheckReport`: refuse anything lacking both
`everworksBackupFormat` and `producedAt`, naming the fields it looked for (spec S-18); accept an
older format version and note domains that did not exist then (spec S-20); describe but refuse to
restore a newer one (spec S-19); classify every domain as restored / record-only / not-present;
compute the follow-up list (credentials to re-enter, nodes to re-enrol, schedules and triggers
that will resume paused).

**Done when:** `pnpm type-check` passes.

---

### T-49 · Verify service spec

**Phase:** P2
**Create:** `packages/agent/src/account-transfer/backup/backup-verify.service.spec.ts`

Fixtures: a good manifest, a foreign JSON object, a truncated manifest, one version behind, one
version ahead. Assert the classification counts and that verification writes nothing.

**Done when:** `cd packages/agent && npx jest --testPathPattern='backup-verify'` passes.

---

### T-50 · Restore appliers

**Phase:** P2
**Create:** `packages/agent/src/account-transfer/backup/restore/` with one applier per restorable
domain, and `restore/index.ts` as the registry

Reuse `packages/agent/src/account-transfer/account-import.service.ts` for the Works and plugins
domains it already handles — do not fork it. Each applier runs in **one transaction per domain**
(spec FR-38), writes schedule-shaped things paused (spec FR-39), and creates every connection
needing a credential in a `needs credential` state (spec FR-40).

**Done when:** `pnpm type-check` passes and every domain whose restorability is `restorable` or
`partly-restorable` has an applier, asserted in T-52.

---

### T-51 · Restore service, dispatcher and task

**Phase:** P2
**Create:** `packages/agent/src/account-transfer/backup/workspace-restore.service.ts`,
`packages/agent/src/tasks/workspace-restore-dispatcher.ts`,
`packages/tasks/src/tasks/trigger/workspace-restore.task.ts`
**Modify:** `packages/agent/src/tasks/_tasks-symbols.ts`,
`packages/agent/src/tasks/job-runtime.providers.ts`,
`packages/tasks/src/trigger/trigger.service.ts`, `packages/tasks/src/tasks/trigger/index.ts`

Same dispatcher pattern as T-22 to T-24.

**Done when:** `npx jest --testPathPattern='tasks'` passes in `packages/agent`, including the
barrel symbol-set assertion.

---

### T-52 · Restore specs

**Phase:** P2
**Create:** `packages/agent/src/account-transfer/backup/restore/restore.spec.ts`

Assert: a domain that fails mid-way rolls back completely and is reported (spec FR-38); no
record-only domain is ever written (spec FR-36); restored schedules, triggers and heartbeats are
paused (spec FR-39); connections land in `needs credential` (spec FR-40); collisions default to
skip and honour overwrite and rename (spec FR-37); every restorable domain has an applier.

**Done when:** `cd packages/agent && npx jest --testPathPattern='restore'` passes.

---

### T-53 · Verify and restore endpoints

**Phase:** P2
**Modify:** `apps/api/src/account/workspace-backup.controller.ts` (routes 9, 11 and 12 of
[plan.md §4](./plan.md#4-api-surface)), `apps/api/src/account/dto/` (restore DTOs),
`apps/api/src/account/workspace-backup.controller.spec.ts`

**Done when:** `cd apps/api && pnpm test` passes with the new route cases.

---

### T-54 · Check panel and restore flow

**Phase:** P2
**Create:** `apps/web/src/components/settings/BackupCheckPanel.tsx`,
`apps/web/src/components/settings/BackupRestoreFlow.tsx`,
`apps/web/src/components/settings/BackupCheckPanel.unit.spec.tsx`
**Modify:** `apps/web/src/components/settings/WorkspaceBackupCard.tsx` (the `Check a backup`
entry point), `apps/web/src/lib/api/workspace-backup.ts`,
`apps/web/src/app/actions/workspace-backup.ts`

The three panel states of [spec §6.9](./spec.md#69-check-a-backup--the-three-states). The file is
read and parsed **in the browser**; anything over 8 MiB or non-JSON is refused before any network
call, and the panel says so. The restore flow reuses the conflict-resolution interaction of
`apps/web/src/components/settings/ImportFlow.tsx` rather than inventing a second one.

**Done when:** the unit spec passes and no network request is made for a refused file.

---

### T-55 · i18n for phase 2

**Phase:** P2
**Modify:** `apps/web/messages/en.json` (the `check.*` and `restore.*` leaves in
[plan.md §8](./plan.md#8-i18n)), then the 20 sibling locale files via the parity script

**Done when:** the parity check passes and no raw key renders.

---

### T-56 · E2E — check and restore

**Phase:** P2
**Create:** `apps/web/e2e/workspace-backup-check.spec.ts`

A good manifest produces a report; a foreign manifest produces the named refusal without
uploading; a newer-format manifest is described and restore is refused; a restore into a
non-empty workspace lists collisions and defaults to skip; the result screen lists paused
schedules and connections needing credentials.

**Done when:** `npx playwright test e2e/workspace-backup-check.spec.ts` passes.

---

### T-57 · Phase 2 gate

**Phase:** P2

`pnpm lint && pnpm type-check && pnpm test`, then the full Playwright account-data and
workspace-backup suites. Walk the **Checking and restoring** block of the spec §8 checklist.

**Done when:** all green and every item in that block passes on a real deployment.

---

## Phase 3 — Automatic backups and foreign archives

Ships the deferred items in spec §7.3 and §7.5. Sequenced last because it multiplies storage cost
and should only run once the manual path's real size and duration distribution is known (§9
telemetry).

### T-58 · Schedule entity fields and migration

**Phase:** P3
**Modify:** `packages/agent/src/entities/workspace-backup.entity.ts` (add `origin` —
`manual` | `scheduled` — and `retainedBy` so automatic archives can have their own retention)
**Create:** `apps/api/src/migrations/1791220100000-AddWorkspaceBackupSchedule.ts` (AW-22 slot 01) plus a small
`workspace_backup_schedules` table (scope, cadence, hour, timezone, enabled, lastRunAt, nextRunAt)

Additive columns and one new table; forward-only; same PR as the entity change (Constitution V).

**Done when:** the migration applies cleanly to a fresh database and is a no-op on second run.

---

### T-59 · Scheduling service and cron

**Phase:** P3
**Create:** `packages/agent/src/account-transfer/backup/workspace-backup-schedule.service.ts`,
`packages/tasks/src/tasks/trigger/workspace-backup-schedule-dispatcher.task.ts`
**Modify:** `apps/api/src/account/workspace-backup.controller.ts` (get/put the schedule)

The cron finds due schedules and calls the **same** `create` the button calls — no second code
path. Automatic archives retain the three most recent independently of the manual daily allowance.

**Done when:** a schedule set to hourly in a test deployment produces exactly one backup per hour
and prunes to three.

---

### T-60 · Completion fan-out

**Phase:** P3
**Modify:** `packages/agent/src/account-transfer/backup/workspace-backup.service.ts`

On a scheduled backup finishing, fan out through the existing notification-channel path
(`packages/agent/src/facades/notification-channel.facade.ts`) in addition to the in-app
notification, so an owner who never opens the settings page still learns their backup failed.

**Done when:** a configured channel receives one message per scheduled outcome and none per
manual one.

---

### T-61 · Restore from an uploaded archive

**Phase:** P3
**Modify:** `apps/api/src/account/workspace-backup.controller.ts` (route 13),
`packages/agent/src/account-transfer/backup/workspace-restore.service.ts`,
`apps/web/src/components/settings/BackupCheckPanel.tsx`

Accept a full archive, store it through the same storage accessor, materialise a
`WorkspaceBackup` row with `origin: 'imported'`, then route into the existing P2 preview/apply
path.

**Done when:** an archive exported from one workspace restores its restorable domains into
another, with the record-only domains reported and skipped.

---

### T-62 · Optional push into the config repo

**Phase:** P3
**Modify:** `packages/agent/src/account-transfer/github-sync.service.ts` (an additive method),
`apps/web/src/components/settings/WorkspaceBackupCard.tsx`

An opt-in that, on a successful scheduled backup, writes the manifest — not the archive — into the
user's existing config repo, so their own repository history records what was backed up and when.

**Done when:** the manifest lands in the configured repo and the existing sync behaviour is
unchanged.

---

### T-63 · Palette command

**Phase:** P3
**Modify:** the AW-01 command registry

One command, "Create workspace backup", visible only to the workspace owner, that calls the same
server action as the button.

**Done when:** the command appears, is owner-gated, and starts a backup.

---

### T-64 · Phase 3 gate

**Phase:** P3

`pnpm lint && pnpm type-check && pnpm test` plus the full Playwright suites. Re-read spec §9 and
close or restate every open question that phase 3 answered — particularly the scheduled-backup
cadence and the retention defaults.

**Done when:** all green, and `docs/features/workspace-backup.md` documents the scheduled path
with the values actually shipped.
