# AW-22 — Backup and export the workspace · Implementation Plan

**Epic:** `AW-22-backup-export` · **Program:** [Agent Workspace](../README.md)
**Spec:** [spec.md](./spec.md) · **Status:** Draft v1 · **Date:** 2026-09-06
**Constitution:** [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)

> Every path in this document was verified to exist in the worktree before it was written down.
> Paths marked **(new)** are created by this epic.

---

## 1. Current state in the codebase

### 1.1 The export that exists today

| Concern | File | What it does |
| --- | --- | --- |
| Domain service | [`packages/agent/src/account-transfer/account-export.service.ts`](../../../../../packages/agent/src/account-transfer/account-export.service.ts) — 379 lines | Loads the user, their Works and their user-plugin rows, walks each Work for items/categories/tags/collections/comparisons via `DataRepository` + `GitFacadeService`, masks secret settings, and returns one `AccountExportPayload` object. Optional v2 tail for agents/skills/tasks. |
| v2 tail | [`agents-skills-tasks-export.service.ts`](../../../../../packages/agent/src/account-transfer/agents-skills-tasks-export.service.ts) — 228 lines | Agents, skills, tasks and task chat, behind four per-feature toggles. Injected `@Optional()`, and a throw inside it is caught and downgraded to a v1 payload. |
| Wire contract | [`types.ts`](../../../../../packages/agent/src/account-transfer/types.ts) — 450 lines | `AccountExportPayload`, `ExportedProfile`, `ExportedWork`, … The `ExportedProfile` doc comment already enumerates the columns deliberately withheld (platform-admin flag, credits, fleet nodes, scope pointers) — that reasoning is reused verbatim by this epic's exclusions list. |
| Import | [`account-import.service.ts`](../../../../../packages/agent/src/account-transfer/account-import.service.ts) — 1 149 lines | Preview with conflict detection, then apply with per-conflict skip / overwrite / rename. |
| Config-repo sync | [`github-sync.service.ts`](../../../../../packages/agent/src/account-transfer/github-sync.service.ts) — 732 lines | Push/pull the account as a private config repo. |
| Module | [`account-transfer.module.ts`](../../../../../packages/agent/src/account-transfer/account-transfer.module.ts) | Providers + exports for all of the above. |
| HTTP | [`apps/api/src/account/account.controller.ts`](../../../../../apps/api/src/account/account.controller.ts) | `GET /api/account/export` (returns the whole payload in the response body, with a `Content-Disposition` header), plus import preview/apply and the sync routes. Carries hand-rolled DoS caps on the import body. |
| API module | [`apps/api/src/account/account.module.ts`](../../../../../apps/api/src/account/account.module.ts) | Imports `AccountTransferModule` and `TenantJobRuntimeModule`; declares `AccountController`. |
| Server actions | [`apps/web/src/app/actions/account-transfer.ts`](../../../../../apps/web/src/app/actions/account-transfer.ts) | `exportAccountData`, `previewImport`, `applyImport`, plus the sync actions. |
| Web client | [`apps/web/src/lib/api/account-transfer.ts`](../../../../../apps/web/src/lib/api/account-transfer.ts) + [`account-transfer.types.ts`](../../../../../apps/web/src/lib/api/account-transfer.types.ts) | Typed fetch wrappers. |
| UI | [`apps/web/src/components/settings/DataManagement.tsx`](../../../../../apps/web/src/components/settings/DataManagement.tsx) | Export card with five checkboxes; builds a `Blob` from `JSON.stringify(result.data, null, 2)` **in the browser** and clicks a synthetic `<a download>`. Also renders `ImportFlow` and `GitHubSync`. |
| Page | [`settings/data/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/data/page.tsx>) | Nine lines: metadata + `<DataManagement />`. |
| Danger zone | [`apps/web/src/components/settings/DangerZone.tsx`](../../../../../apps/web/src/components/settings/DangerZone.tsx) | Renders an export button that calls the same server action, next to the account-deletion control. |
| Nav | [`settings-layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx>) | The settings tab list. `data` is already a tab; no new tab is required. |
| Route constants | [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts) | `DASHBOARD_SETTINGS_DATA: '/settings/data'` (line 233), `DASHBOARD_SETTINGS_DANGER_ZONE: '/settings/danger'` (line 232). Both already exist. |
| E2E | [`apps/web/e2e/account-data.spec.ts`](../../../../../apps/web/e2e/account-data.spec.ts) | Covers the page renders, the danger-zone confirmation, and `GET /api/account/export` returning 200. |

**The three properties that make it unfit for the spec's job**, all visible in the files above:

1. **It is synchronous and buffered end to end.** The service returns one object; the controller
   serialises it into the response; the server action returns it to the browser; the browser
   stringifies it again. Three full copies in memory, inside one request. Spec FR-2 forbids this.
2. **Coverage is five domains out of fifteen.** `AccountExportPayload.data` has exactly
   `profile`, `works`, `userPlugins`, and the optional `agents` / `skills` / `tasks`.
3. **It leaves no record.** There is no table, no history, no expiry, nothing to answer "when did
   I last back up".

### 1.2 The storage seam

| File | Relevance |
| --- | --- |
| [`packages/plugin/src/contracts/capabilities/storage.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/storage.interface.ts) | `IStoragePlugin` — `putObject(StoragePutInput): Promise<StoragePutResult>`, `getObject(key)`, `deleteObject(key)`, optional `presignPut`. **`StoragePutInput.buffer` is a `Buffer`** — the whole object must be in memory. §7 addresses this. |
| [`apps/api/src/uploads/storage-backend.factory.ts`](../../../../../apps/api/src/uploads/storage-backend.factory.ts) | `getActiveStorageBackend()` — selects and caches the backend from `STORAGE_BACKEND` (`local-fs` default, `aws-s3`, `minio`, `github-storage`), running the plugin's `onLoad` against a stub context. |
| [`apps/api/src/uploads/uploads.service.ts`](../../../../../apps/api/src/uploads/uploads.service.ts) | The existing consumer, and the model for owner-scoped reads. |
| [`apps/api/src/uploads/uploads.module.ts`](../../../../../apps/api/src/uploads/uploads.module.ts) | Wiring, including the `USER_UPLOAD_REPOSITORY` / `WORK_REPO_RESOLVER` token indirection used to keep TypeORM out of the uploads unit-test import graph. |

### 1.3 The background-work seam

| File | Relevance |
| --- | --- |
| [`packages/agent/src/tasks/_tasks-symbols.ts`](../../../../../packages/agent/src/tasks/_tasks-symbols.ts) | The single source of truth for the runtime symbols the `@ever-works/agent/tasks` barrel exposes. Adding a dispatcher without adding its name here fails `tasks.spec.ts`. |
| [`packages/agent/src/tasks/kb-embed-document-dispatcher.ts`](../../../../../packages/agent/src/tasks/kb-embed-document-dispatcher.ts) | The shape every dispatcher copies: a `Payload` type, an interface with one `dispatchX(payload): Promise<string \| null>`, and a `Symbol(...)` token. `null` means "could not enqueue". |
| [`packages/agent/src/tasks/job-runtime.providers.ts`](../../../../../packages/agent/src/tasks/job-runtime.providers.ts) | `buildJobRuntimeProviders()` — binds every `*_DISPATCHER` symbol through `JOB_RUNTIME_PROVIDER_REGISTRY`. New symbols are wired here, never at a call site. |
| [`packages/tasks/src/trigger/trigger.service.ts`](../../../../../packages/tasks/src/trigger/trigger.service.ts) | The producer-side implementation (`dispatchWorkImport`, `dispatchKbEmbedDocument`, …), each guarded by `ensureConfigured()`. |
| [`packages/tasks/src/tasks/trigger/kb-embed-document.task.ts`](../../../../../packages/tasks/src/tasks/trigger/kb-embed-document.task.ts) | The consumer-side model: `task<'id', Payload>({ … })`, `withWorkerContext`, explicit skip-and-ack reasons versus real throws. |
| [`packages/tasks/src/tasks/trigger/index.ts`](../../../../../packages/tasks/src/tasks/trigger/index.ts) | Task barrel. |
| [`packages/tasks/src/tasks/trigger/terminal-transcript-gc.task.ts`](../../../../../packages/tasks/src/tasks/trigger/terminal-transcript-gc.task.ts) | The closest model for this epic's retention sweeper: a cron `schedules.task` that deletes aged rows. |

### 1.4 Entity, repository and scope registration

| File | Why it must be touched for a new entity |
| --- | --- |
| [`packages/agent/src/entities/index.ts`](../../../../../packages/agent/src/entities/index.ts) | Barrel export. |
| [`packages/agent/src/database/_entity-names.ts`](../../../../../packages/agent/src/database/_entity-names.ts) | `AGENT_ENTITY_NAMES` — a drift spec counts it. |
| [`packages/agent/src/database/_entities-inventory.ts`](../../../../../packages/agent/src/database/_entities-inventory.ts) | The `ENTITIES` array consumed by the datasource config. |
| [`packages/agent/src/database/_repository-inventory.ts`](../../../../../packages/agent/src/database/_repository-inventory.ts) + [`database/index.ts`](../../../../../packages/agent/src/database/index.ts) | `REPOSITORY_PROVIDERS` and the barrel. |
| [`apps/api/src/scope/scope-context.service.ts`](../../../../../apps/api/src/scope/scope-context.service.ts), [`scope-stamping.subscriber.ts`](../../../../../apps/api/src/scope/scope-stamping.subscriber.ts), [`scope-ownership.guard.ts`](../../../../../apps/api/src/scope/scope-ownership.guard.ts) | Resolve the active workspace, stamp `tenantId`/`organizationId` on insert, and gate reads. |
| [`apps/api/src/migrations/`](../../../../../apps/api/src/migrations/) | Timestamp-prefixed files; highest on `develop` at time of writing is `1790100000000-AddReleaseVerification.ts`. This epic stamps from its reserved block ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)). |

### 1.5 What does not exist today

- No table, entity or repository for an export attempt of any kind.
- No archive writer, no manifest, no checksums, no published format reference.
- No streaming write path into the storage backend (`putObject` is buffer-only).
- No background job that produces a user-downloadable artefact.
- No coverage for ten of the fifteen domains in spec FR-13.
- No user-facing documentation of the export shape. `docs/features/data-management.md` describes
  the page, not the payload.

---

## 2. Architecture and the seam this plugs into

```
  ┌── apps/web ───────────────────────────────────────────────────────────────┐
  │  settings/data/page.tsx                                                   │
  │    └─ DataManagement.tsx  (unchanged sections below)                      │
  │         └─ WorkspaceBackupCard.tsx      (new)                             │
  │              ├─ useWorkspaceBackup()  poll 5s → 15s, pauses when hidden   │
  │              ├─ WorkspaceBackupHistory.tsx                                │
  │              ├─ WorkspaceBackupCoverageDrawer.tsx                         │
  │              └─ BackupCheckPanel.tsx                                      │
  │  settings/danger → DangerZone.tsx  + last-backup banner                   │
  │  app/api/account/backups/[id]/download/route.ts  (BFF, pipes the body)    │
  └───────────────────────────────┬───────────────────────────────────────────┘
                                  │ session cookie → Bearer, X-Scope-Slug
  ┌── apps/api ──────────────────▼────────────────────────────────────────────┐
  │  WorkspaceBackupController  @Controller('api/account/backups')            │
  │    create · list · get · current · cancel · delete                        │
  │    download-link · download (streams) · verify · format                   │
  │    restore/preview · restore/apply            (P2/P3)                     │
  │  guards: session + ScopeOwnershipGuard + owner-only check                 │
  └───────────────────────────────┬───────────────────────────────────────────┘
                                  │
  ┌── packages/agent/src/account-transfer (extended, nothing removed) ────────┐
  │  WorkspaceBackupService        lifecycle: create/adopt, rate limit,       │
  │                                cancel, expire, download-link              │
  │  WorkspaceBackupRunner         the 15-domain walk; owns the archive       │
  │  BackupArchiveWriter           zip stream → storage; checksums; manifest  │
  │  BackupDomainCollector[]       one per domain, each streams rows in pages │
  │  BackupManifestBuilder         the published contract (format.ts)         │
  │  BackupRestoreService  (P2)    delegates to AccountImportService where it │
  │                                already knows how, adds the new domains    │
  │  ── existing, untouched ──                                                │
  │  AccountExportService · AccountImportService · GitHubSyncService          │
  └───────────────────────────────┬───────────────────────────────────────────┘
                                  │ WORKSPACE_BACKUP_DISPATCHER (Constitution IV)
  ┌── packages/tasks ────────────▼────────────────────────────────────────────┐
  │  workspace-backup.task.ts        builds one archive, heartbeats           │
  │  workspace-backup-sweeper.task.ts  cron: expire artefacts, fail stalls    │
  └───────────────────────────────┬───────────────────────────────────────────┘
                                  │ IStoragePlugin (+ optional stream methods)
                        local-fs · aws-s3 · minio · github-storage
```

**Seam choices and why:**

- **The runner lives beside the existing exporter, not inside it.** `AccountExportService`
  answers "give me a JSON payload for these opt-in sections"; the runner answers "write every
  domain to a stream". Merging them would force the small, useful, synchronous export to grow a
  streaming shape it does not need. The runner *reuses* the existing per-Work content walk for
  domain D6 by calling `AccountExportService`'s Work path, so there is exactly one implementation
  of "read a Work's items out of its data repo".
- **The archive never passes through the API process as one object.** The runner writes into a
  zip stream that is piped straight at the storage backend, and the download route pipes bytes
  back the same way — mirroring the streaming already used by
  [`apps/web/src/app/api/credits/usage/export/route.ts`](../../../../../apps/web/src/app/api/credits/usage/export/route.ts).
- **One collector per domain, all fault-isolated.** Each collector is an independent unit with
  its own page size and its own try/catch; spec FR-17 requires a failing domain not to fail the
  archive, and that is only cheap if the domains do not share a transaction.
- **The manifest is a first-class module, not a by-product.** `format.ts` in
  `packages/contracts` holds the domain list, restorability classes and version constant, so the
  API, the runner, the verifier, the web report and the published documentation all read the same
  source. The spec's "documented shape" cannot drift from the writer.

---

## 3. Data model

### 3.1 New entity — `WorkspaceBackup`

**Create:** `packages/agent/src/entities/workspace-backup.entity.ts` **(new)**
`@Entity('workspace_backups')`.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` PK | no | `@PrimaryGeneratedColumn('uuid')` |
| `userId` | `uuid` | no | The owner who requested it (spec FR-10) |
| `tenantId` | `uuid` | yes | Scope, stamped by `scope-stamping.subscriber.ts` |
| `organizationId` | `uuid` | yes | `NULL` = the un-organized workspace (spec FR-9) |
| `status` | `varchar(24)` | no | `queued` `running` `ready` `ready_with_gaps` `failed` `cancelled` `expired` `deleted` |
| `failureReason` | `varchar(32)` | yes | `stalled` `timeout` `too_large` `storage_unavailable` `cancelled_by_user` `internal` |
| `failureDetail` | `text` | yes | Operator-facing detail; never rendered raw to the user |
| `includeFullHistory` | `boolean` default `false` | no | Spec FR-7 |
| `formatVersion` | `varchar(16)` | no | e.g. `1.0` (spec FR-27) |
| `buildRef` | `varchar(64)` | yes | The build that produced it (spec FR-24) |
| `requestedAt` | `timestamptz` | no | `@CreateDateColumn` |
| `startedAt` | `timestamptz` | yes | |
| `finishedAt` | `timestamptz` | yes | |
| `lastHeartbeatAt` | `timestamptz` | yes | Stall detection (spec FR-5) |
| `progressPercent` | `int` default `0` | no | |
| `currentDomain` | `varchar(48)` | yes | Domain key, translated client-side |
| `domainsCompleted` | `int` default `0` | no | |
| `domainsTotal` | `int` default `15` | no | Stored, not derived, so an old row stays legible when the domain list grows |
| `manifestSummary` | `text` (`simple-json`) | yes | The manifest minus its per-file lists — survives artefact deletion (spec FR-29) |
| `storageBackend` | `varchar(32)` | yes | Which backend holds it |
| `storageKey` | `varchar(512)` | yes | Opaque key from `putObject` |
| `sizeBytes` | `bigint` | yes | |
| `sha256` | `varchar(64)` | yes | Of the archive itself |
| `fileCount` | `int` default `0` | no | Files included |
| `omittedFileCount` | `int` default `0` | no | Spec FR-15 |
| `expiresAt` | `timestamptz` | yes | `finishedAt + retention` (spec FR-28) |
| `artifactDeletedAt` | `timestamptz` | yes | Set on expiry or manual delete |
| `downloadCount` | `int` default `0` | no | Telemetry (§9) |
| `lastDownloadedAt` | `timestamptz` | yes | |
| `runtimeRunId` | `varchar(128)` | yes | Handle returned by the dispatcher, for cancellation |
| `credentialVersion` | `int` | yes | Enqueue-time stamp, mirroring the pattern in `packages/agent/src/tasks/runtime-binding-stamper.service.ts` |
| `updatedAt` | `timestamptz` | no | `@UpdateDateColumn` |

Indexes:

- `idx_workspace_backups_scope` on `(userId, organizationId, requestedAt)` — the history read.
- `idx_workspace_backups_sweep` on `(status, expiresAt)` — the retention cron and stall sweep.
- `uq_workspace_backups_active` — a **partial** unique index on
  `(userId, COALESCE(organizationId, '00000000-0000-0000-0000-000000000000'))`
  `WHERE status IN ('queued','running')`, enforcing spec FR-3 at the database rather than in
  application logic. Written as raw SQL guarded on the Postgres driver, exactly as
  `work_budgets` does it, so TypeORM's SQLite test driver does not synthesise a non-partial
  duplicate.

**No new columns on any existing table.** The backup reads everything else.

### 3.2 New contract module (types only, no schema)

**Create:** `packages/contracts/src/backup/format.ts` **(new)** plus its area barrel
`packages/contracts/src/backup/index.ts` **(new)**, re-exported from
[`packages/contracts/src/index.ts`](../../../../../packages/contracts/src/index.ts) — the package is
organised as one barrel per area, and
[`packages/contracts/src/__tests__/index.barrel.spec.ts`](../../../../../packages/contracts/src/__tests__/index.barrel.spec.ts)
pins the `AREAS` list, so the new area must be added there in the same change or CI fails.

```
BACKUP_FORMAT_VERSION = '1.0'

BackupDomainKey =
  'account' | 'organizations' | 'agents' | 'missions' | 'tasks' | 'works' |
  'knowledge' | 'schedules' | 'runs' | 'decisions' | 'communication' |
  'connections' | 'fleet' | 'billing' | 'activity'          // 15, spec FR-13

BackupDomainStatus   = 'complete' | 'trimmed' | 'partial' | 'failed' | 'empty'
BackupRestorability  = 'restorable' | 'record-only' | 'partly-restorable'
BackupOmissionReason = 'size_limit' | 'file_missing' | 'unreadable'

BackupManifest {
  everworksBackupFormat: string     // the sentinel the verifier looks for (spec S-18)
  formatVersion: string
  producedAt: string                // ISO-8601
  producedBy: { build: string; instance?: string }
  workspace: { id: string; slug: string; displayName: string; kind: 'organization' | 'personal' }
  account:   { id: string; displayName: string; email: string }
  options:   { includeFullHistory: boolean }
  domains:   BackupDomainReport[]   // always all 15
  files:     { included: number; bytes: number; omitted: BackupOmission[] }
  exclusions: BackupExclusion[]     // the nine categories of spec FR-18
  totals:    { records: number; bytes: number }
}

BackupDomainReport {
  key: BackupDomainKey
  status: BackupDomainStatus
  restorability: BackupRestorability
  records: number
  files: { name: string; records: number; sha256: string }[]
  trim?: { field: string; cutoff: string; omittedRecords: number }
  error?: { code: string }
}
```

`BACKUP_DOMAINS` — a frozen array pairing each key with its restorability, its collector id and
its default trim window — lives here too and is the **only** place the fifteen domains are
enumerated. A unit test asserts `BACKUP_DOMAINS.length === 15` and that every key has a
collector, so adding a domain without a collector fails CI.

### 3.3 Migration (Constitution V — same PR as §3.1)

**Create:** `apps/api/src/migrations/1791220000000-CreateWorkspaceBackups.ts` **(new)**

- `up()` creates `workspace_backups` with `ifNotExists`, portable `Table` / `TableColumn` DDL so
  the better-sqlite3 CI driver and Postgres both apply it, a foreign key `userId → users(id)`
  `ON DELETE CASCADE`, the two plain indexes, and the partial unique index via
  `queryRunner.query(...)` guarded on `queryRunner.connection.options.type === 'postgres'`.
- `down()` drops only `workspace_backups`.
- Forward-only, additive, no data movement, and every step existence-guarded so a partially
  applied database converges.
- The timestamp is AW-22 slot 00 ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)). **Before merge**, rebase on `develop`;
  if a migration with a higher timestamp has landed, re-stamp filename and class to exceed it.

### 3.4 Activity action types (no migration)

Four additive members in
[`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts):
`WORKSPACE_BACKUP_CREATED`, `WORKSPACE_BACKUP_DOWNLOADED`, `WORKSPACE_BACKUP_DELETED`,
`WORKSPACE_BACKUP_RESTORED`. `activity_log.actionType` is a plain `varchar`, so adding enum
members needs no schema change — the enum is a code-level contract only.

### 3.5 The archive layout on disk

```
everworks-backup-<workspace-slug>-<YYYY-MM-DD>-<short-id>.zip
├── manifest.json
├── README.md
├── checksums.txt
├── data/
│   ├── account/            profile.jsonl · preferences.jsonl · terms-acceptance.jsonl ·
│   │                       api-keys.jsonl (name + prefix only)
│   ├── organizations/      organization.jsonl · members.jsonl · invitations.jsonl ·
│   │                       teams.jsonl · team-members.jsonl · team-resources.jsonl ·
│   │                       notification-defaults.jsonl
│   ├── agents/             agents.jsonl · memberships.jsonl · collaborators.jsonl ·
│   │                       budgets.jsonl · repo-attachments.jsonl · mcp-bindings.jsonl ·
│   │                       email-assignments.jsonl · tool-grants.jsonl · skills.jsonl ·
│   │                       skill-bindings.jsonl · skill-files.jsonl
│   ├── missions/           missions.jsonl · mission-goals.jsonl · mission-works.jsonl ·
│   │                       goals.jsonl · goal-events.jsonl · goal-metric-samples.jsonl ·
│   │                       ideas.jsonl · idea-works.jsonl
│   ├── tasks/              tasks.jsonl · assignees.jsonl · approvers.jsonl · reviewers.jsonl ·
│   │                       watchers.jsonl · blocks.jsonl · relations.jsonl · chat.jsonl ·
│   │                       attachments.jsonl · kb-mentions.jsonl · review-rejections.jsonl ·
│   │                       templates.jsonl · template-steps.jsonl · workflows.jsonl
│   ├── works/              works.jsonl · members.jsonl · custom-domains.jsonl ·
│   │                       advanced-prompts.jsonl · plugins.jsonl · budgets.jsonl ·
│   │                       deployments.jsonl · generation-history.jsonl · invitations.jsonl
│   │                       └── content/<work-slug>/{works.yml,items.jsonl,categories.jsonl,
│   │                                               tags.jsonl,collections.jsonl,
│   │                                               comparisons.jsonl}
│   ├── knowledge/          documents.jsonl · tags.jsonl · uploads.jsonl · citations.jsonl ·
│   │                       memory-folders.jsonl · user-uploads.jsonl · retrieval-log.jsonl
│   ├── schedules/          work-schedules.jsonl · inbound-triggers.jsonl · trigger-fires.jsonl
│   ├── runs/               agent-runs.jsonl · run-logs.jsonl · terminal-transcripts.jsonl ·
│   │                       work-agent-runs.jsonl · work-agent-run-logs.jsonl ·
│   │                       workflow-runs.jsonl · plugin-usage-events.jsonl
│   ├── decisions/          escalations.jsonl · action-proposals.jsonl · inbox.jsonl
│   ├── communication/      email-addresses.jsonl · email-conversations.jsonl ·
│   │                       email-messages.jsonl · notifications.jsonl · channels.jsonl ·
│   │                       channel-deliveries.jsonl · preferences.jsonl · meetings.jsonl
│   ├── connections/        user-plugins.jsonl · mcp-connections.jsonl · repo-connections.jsonl ·
│   │                       environments.jsonl · code-host-installations.jsonl ·
│   │                       webhook-subscriptions.jsonl · webhook-deliveries.jsonl ·
│   │                       ingest-bindings.jsonl · ingest-cursors.jsonl ·
│   │                       external-issue-links.jsonl
│   ├── fleet/              nodes.jsonl · execution-preferences.jsonl · agent-affinities.jsonl ·
│   │                       jobs.jsonl
│   ├── billing/            subscription.jsonl · invoices.jsonl · credit-ledger.jsonl ·
│   │                       usage-ledger.jsonl · licence-purchases.jsonl
│   └── activity/           activity.jsonl
└── files/
    └── <uploadId>/<original-filename>
```

Every `*.jsonl` line is one record: `{ "id": …, "…": … }`, keys in a stable order, sorted by
`createdAt` then `id` so two archives of unchanged data diff cleanly (spec FR-22).

### 3.6 Redaction rules the collectors enforce

Implemented once, in `packages/agent/src/account-transfer/backup/redaction.ts` **(new)**, and
unit-tested against a fixture row of every entity that carries a secret column:

| Rule | Applies to |
| --- | --- |
| Drop the column, emit `"<field>": { "wasSet": true }` | every `*Encrypted` / `*SecretEncrypted` column, plugin `secretSettings`, connection auth headers, trigger signing secrets, webhook secrets |
| Drop the row entirely | `session`, `refresh_tokens`, `account`, `verification`, `cache_entries`, `credit_meter_events`, `tenant_credential_snapshot`, `work_knowledge_chunks`, `work_knowledge_chunk_coordinates` |
| Drop named columns | `users.password`, `users.passwordResetToken`, `users.emailVerificationToken`, `users.magicLinkToken`, `users.isPlatformAdmin`, `api_keys.hashedKey`, `fleet_nodes.enrollmentTokenHash`, `billing_profiles.providerCustomerId` and every `provider*Id` on billing rows |

A CI guard (`redaction.spec.ts`) reflects over `AGENT_ENTITY_NAMES` and fails when an entity has
a column matching `/secret|password|token|hash|credential/i` that no rule covers — so a new
secret column cannot silently start being exported.

---

## 4. API surface

New controller: `apps/api/src/account/workspace-backup.controller.ts` **(new)**,
`@Controller('api/account/backups')`, registered in
[`apps/api/src/account/account.module.ts`](../../../../../apps/api/src/account/account.module.ts).
Every route is session-guarded, scope-resolved via `ScopeContextService`, and additionally gated
by an owner check (spec FR-10). DTOs live in `apps/api/src/account/dto/` **(new)** and are
class-validator classes so the global `ValidationPipe` applies — deliberately unlike the existing
export/import routes, whose hand-rolled caps exist precisely because their bodies are erased
interfaces.

| # | Method | Path | Request | Response | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `POST` | `/api/account/backups` | `CreateBackupDto { includeFullHistory?: boolean }` | `202 { backup: BackupDto }`; `200 { backup, adopted: true }` when one is already running; `429 { retryAt }` over the daily allowance; `503` when storage is unconfigured | FR-2, FR-3, FR-4, FR-46 |
| 2 | `GET` | `/api/account/backups` | `?limit=20&cursor=` | `200 { backups: BackupDto[], nextCursor }` | `limit` max 50, default 20 (FR-30) |
| 3 | `GET` | `/api/account/backups/current` | — | `200 { backup: BackupDto \| null }` | The poll target while running (FR-41) |
| 4 | `GET` | `/api/account/backups/:id` | — | `200 { backup: BackupDto }` · `404` cross-scope | |
| 5 | `POST` | `/api/account/backups/:id/cancel` | — | `202` · `409` if terminal | FR-8 |
| 6 | `DELETE` | `/api/account/backups/:id` | — | `204` | Deletes bytes, keeps the row as `deleted` (FR-31) |
| 7 | `POST` | `/api/account/backups/:id/download-link` | — | `200 { url, expiresAt }` | HMAC token, 15-minute TTL, bound to backup id + user id + scope (FR-12) |
| 8 | `GET` | `/api/account/backups/:id/download` | `?token=` | `200` streamed `application/zip` with `Content-Disposition`, `Content-Length`, `X-Checksum-Sha256` · `410` expired · `403` bad token | Pipes from the storage backend; never buffers |
| 9 | `POST` | `/api/account/backups/verify` | `VerifyManifestDto { manifest: object }`, body cap 8 MiB | `200 { report: BackupCheckReport }` · `422 { code: 'not_a_backup_manifest', looked_for: [...] }` · `422 { code: 'format_too_new', formatVersion }` | FR-34, FR-35, S-18, S-19 |
| 10 | `GET` | `/api/account/backups/format` | — | `200 { formatVersion, domains: BackupDomainDescriptor[] }` | The machine-readable field reference; the docs page renders from it |
| 11 | `POST` | `/api/account/backups/:id/restore/preview` | `RestorePreviewDto { domains?: BackupDomainKey[] }` | `200 { report, conflicts }` | **P2** — restore from a backup this workspace holds |
| 12 | `POST` | `/api/account/backups/:id/restore/apply` | `RestoreApplyDto { resolutions: [] }` | `202 { restoreId }` | **P2**, runs on the job runtime, per-domain transaction (FR-38) |
| 13 | `POST` | `/api/account/backups/restore/upload` | multipart archive | `202 { backupId }` | **P3** — ingest a foreign archive, then routes 11/12 |

`BackupDto` mirrors the entity minus `storageKey`, `failureDetail`, `runtimeRunId` and
`credentialVersion` — a response DTO with `@Exclude()` on those, never the entity itself.

**Web BFF route:** `apps/web/src/app/api/account/backups/[id]/download/route.ts` **(new)** —
copied from
[`apps/web/src/app/api/credits/usage/export/route.ts`](../../../../../apps/web/src/app/api/credits/usage/export/route.ts):
forwards the auth cookie as a Bearer token, allowlists exactly `token` as a forwarded query
param, carries the workspace selector via `?scope=` and converts it with
`applyBffWorkspaceScopeFromNavigation` from `@/lib/api/bff-scope` (an `<a download>` cannot send
`x-ever-workspace`), and **pipes `response.body`** rather than awaiting it.

---

## 5. Web

### 5.1 New files

| File | Kind | Responsibility |
| --- | --- | --- |
| `apps/web/src/lib/api/workspace-backup.ts` **(new)** | client | Typed fetch wrappers for routes 1–10 |
| `apps/web/src/lib/api/workspace-backup.types.ts` **(new)** | types | `BackupDto`, `BackupCheckReport`, re-exporting `BackupDomainKey` from `@ever-works/contracts` |
| `apps/web/src/app/actions/workspace-backup.ts` **(new)** | `'use server'` | `createBackup`, `cancelBackup`, `deleteBackup`, `mintDownloadLink`, `verifyManifest`; each `ensureAuth()`-guarded and Zod-validated, mirroring `account-transfer.ts` |
| `apps/web/src/components/settings/WorkspaceBackupCard.tsx` **(new)** | client | The card and all eleven states of spec §6 |
| `apps/web/src/components/settings/WorkspaceBackupHistory.tsx` **(new)** | client | The last-20 list with per-row actions and arrow-key navigation |
| `apps/web/src/components/settings/WorkspaceBackupCoverageDrawer.tsx` **(new)** | client | "What's inside" — renders `manifestSummary`; `Esc` closes, focus returns |
| `apps/web/src/components/settings/BackupCheckPanel.tsx` **(new)** | client | Drop a `manifest.json`, render the report, route into restore |
| `apps/web/src/components/settings/useWorkspaceBackup.ts` **(new)** | hook | Poll `current` at 5 s for 5 minutes then 15 s; stop on `document.hidden`; expose status, progress and a 30 s-throttled live-region string |
| `apps/web/src/components/settings/LastBackupBanner.tsx` **(new)** | client | The Danger-zone banner |
| `apps/web/src/app/api/account/backups/[id]/download/route.ts` **(new)** | BFF | Streaming proxy (§4) |

### 5.2 Modified files (all additive)

| File | Change |
| --- | --- |
| [`apps/web/src/components/settings/DataManagement.tsx`](../../../../../apps/web/src/components/settings/DataManagement.tsx) | Render `<WorkspaceBackupCard />` **above** the existing export card. Nothing existing is removed, re-worded or re-ordered relative to itself. |
| [`apps/web/src/components/settings/DangerZone.tsx`](../../../../../apps/web/src/components/settings/DangerZone.tsx) | Render `<LastBackupBanner />` at the top. The existing export button and deletion control are untouched. |
| [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) | New keys under `dashboard.settings.data.backup` (§8) |
| [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts) | No change — `/settings/data` and `/settings/danger` already exist |

### 5.3 State and data fetching

- The card is a **client component**. First paint renders the skeleton (spec §6.1) rather than a
  server-fetched snapshot, because the interesting state is "is one running right now", which is
  stale the instant it is serialised.
- One `useWorkspaceBackup()` hook owns everything: it fetches `GET current` and `GET list` in
  parallel on mount, then polls `current` only while a backup is `queued` or `running`.
- Polling stops on `visibilitychange` → hidden and resumes with an immediate fetch on show, so a
  backgrounded tab costs nothing (spec FR-41).
- Mutations are server actions that return the updated `BackupDto`; the hook applies the result
  optimistically and re-polls, so two tabs converge (spec S-9).
- Download is a plain `<a href download>` at the BFF route with a token minted on `mouseDown`, so
  a stale token is replaced before the click completes (spec S-15) and the browser — not
  JavaScript — owns the transfer.
- `Check a backup` reads the dropped file with `FileReader`, parses it in the browser, refuses
  anything over 8 MiB or non-JSON **before** any network call, and only then posts the parsed
  object. The panel says so (spec §6.9 privacy note).

---

## 6. Background work

All of it goes through the configured job-runtime provider via DI symbols (Constitution IV). No
call site imports a vendor SDK.

### 6.1 The archive job

- **Dispatcher:** `packages/agent/src/tasks/workspace-backup-dispatcher.ts` **(new)** —
  `WorkspaceBackupPayload { backupId, userId, tenantId?, organizationId?, includeFullHistory }`,
  interface `WorkspaceBackupDispatcher { dispatchWorkspaceBackup(payload): Promise<string | null> }`,
  token `WORKSPACE_BACKUP_DISPATCHER`. Copied from
  [`kb-embed-document-dispatcher.ts`](../../../../../packages/agent/src/tasks/kb-embed-document-dispatcher.ts).
- **Registration:** the symbol name is added to `TASKS_BARREL_RUNTIME_SYMBOLS` in
  [`_tasks-symbols.ts`](../../../../../packages/agent/src/tasks/_tasks-symbols.ts) (alphabetical) and
  bound in [`job-runtime.providers.ts`](../../../../../packages/agent/src/tasks/job-runtime.providers.ts);
  the producer method lands on
  [`packages/tasks/src/trigger/trigger.service.ts`](../../../../../packages/tasks/src/trigger/trigger.service.ts)
  behind its `ensureConfigured()` guard.
- **Consumer:** `packages/tasks/src/tasks/trigger/workspace-backup.task.ts` **(new)** —
  `maxDuration` 3600 s (spec FR-6), `queue.concurrencyLimit: 2` globally with a per-workspace
  concurrency key, `retry.maxAttempts: 1` (a partial archive must never be silently re-run;
  retries happen per domain inside the runner).
- **Enqueue failure is not silent.** A `null` from the dispatcher means the runtime is not
  configured; the service immediately marks the row `failed` / `internal` and the card shows the
  storage-unavailable copy rather than a backup stuck at `queued` forever.
- **Heartbeat:** the runner updates `lastHeartbeatAt`, `progressPercent`, `currentDomain` and
  `domainsCompleted` in one `UPDATE` after each domain and at least every 30 s within a long
  domain (spec FR-5).
- **Cancellation:** `POST :id/cancel` sets `status = cancelled` under a compare-and-set
  (`WHERE status IN ('queued','running')`); the runner checks the row between domains and between
  pages inside a domain, then aborts the zip stream and deletes the partial object.

### 6.2 The sweeper cron

`packages/tasks/src/tasks/trigger/workspace-backup-sweeper.task.ts` **(new)**, a
`schedules.task` at `17 * * * *` (hourly, off the hour to avoid the crowded top-of-hour slot),
modelled on
[`terminal-transcript-gc.task.ts`](../../../../../packages/tasks/src/tasks/trigger/terminal-transcript-gc.task.ts).
Three passes, each idempotent and each under `DistributedTaskLockService`:

1. **Expire artefacts** — `status = 'ready' | 'ready_with_gaps'` and `expiresAt < now`:
   `deleteObject(storageKey)`, then set `status='expired'`, `artifactDeletedAt=now`,
   `storageKey=NULL` (spec FR-28).
2. **Fail stalls** — `status='running'` and `lastHeartbeatAt < now - 10 min`, or
   `status='queued'` and `requestedAt < now - 15 min`: set `failed` / `stalled`, delete any
   partial object (spec FR-5, S-14).
3. **Prune records** — rows terminal for more than 90 days are deleted (spec FR-29).

### 6.3 Restore job (P2)

`packages/tasks/src/tasks/trigger/workspace-restore.task.ts` **(new)** behind
`WORKSPACE_RESTORE_DISPATCHER`. One transaction **per domain** (spec FR-38), reusing
`AccountImportService` for the Works/plugins domain it already knows and new per-domain appliers
for the rest. Everything schedule-shaped is written in a paused state (spec FR-39).

---

## 7. Plugin boundaries

**Constitution I — nothing external is spoken to directly.** The archive is written to and read
from whatever `IStoragePlugin` is active; the runner never imports a cloud SDK, never touches the
filesystem directly, and never names a backend.

**Constitution II — no hardcoded plugin ids outside plugins.** The runner resolves its backend
through
[`getActiveStorageBackend()`](../../../../../apps/api/src/uploads/storage-backend.factory.ts), the
same selector uploads use, injected as a token so the agent package does not import the API
module.

**One contract extension, and why it is necessary.** `StoragePutInput.buffer` is a `Buffer`
([`storage.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/storage.interface.ts)),
so writing a multi-gigabyte archive through today's contract would require holding it in memory —
exactly the failure this epic exists to remove. This epic adds two **optional** methods to
`IStoragePlugin`, declared as the optional capabilities `put-object-stream` and
`get-object-stream`:

```
putObjectStream?(input: StoragePutStreamInput): Promise<StoragePutResult>
  // input.stream: Readable, input.filename/mimeType/ownerId as today,
  // input.expectedSize?: number
getObjectStream?(key: string): Promise<{ stream: Readable; mimeType: string; size?: number }>
```

- Implemented in `packages/plugins/local-fs` (pipe to a temp path, then rename) and
  `packages/plugins/aws-s3` / `packages/plugins/minio` (multipart upload). Not implemented for
  `github-storage`, whose blob API is not a streaming target.
- Optional, so no existing plugin breaks and no plugin major version is needed (Constitution X).
- The runner **capability-checks** rather than backend-checks: with streaming it applies the
  5 GiB ceiling of spec FR-16; without it, it applies a 512 MiB ceiling and says so in the
  unavailable/limits copy. A backend with no streaming is a smaller limit, never a wrong result.
- The canonical plugin list at `docs/plugin-system/built-in-plugins.md` is updated with the two
  new capability names (Constitution VIII). No new plugin package is added by this epic.

**No new external integration.** The zip container itself is produced in-process by a streaming
zip encoder added to `packages/agent/package.json`. `jszip` is already a dependency there
(`packages/agent/src/agent-plugins/export.service.ts` uses it for small plugin bundles) but it
builds the whole archive in memory, which is the property being removed — so it stays where it is
and is not used here.

---

## 8. i18n

All keys land under `dashboard.settings.data.backup` in
[`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json), beside the existing
`dashboard.settings.data.*` block. **Leaf key names are camelCase and never contain a literal
dot** — a dotted leaf is rejected by the runtime and reds several e2e shards at once.

```
dashboard.settings.data.backup
  title                     subtitle                  createButton
  creating                  optionsToggle             includeFullHistory
  includeFullHistoryHelp    emptyState                nearlyEmptyResult
  runningHeadline           runningDetail             runningReassurance
  cancelButton              readySummary              partialSummary
  partialHeadline           availableUntil            expiredRow
  downloadButton            coverageLink              deleteButton
  deleteConfirmTitle        deleteConfirmBody         deleteConfirmAction
  encryptionNotice          retentionNotice           rateLimited
  alreadyRunning            unavailable               notOwner
  earlierBackupsHeading     showAllHistory            tryAgainButton
  progressAnnouncement
  failure.stalled           failure.timeout           failure.tooLarge
  failure.storage           failure.internal
  coverage.title            coverage.columnSection    coverage.columnRecords
  coverage.columnStatus     coverage.columnRestorable coverage.filesIncluded
  coverage.filesOmitted     coverage.neverIncluded    coverage.formatReference
  coverage.statusComplete   coverage.statusTrimmed    coverage.statusPartial
  coverage.statusFailed     coverage.statusEmpty
  coverage.restorableYes    coverage.restorableRecord coverage.restorablePartly
  coverage.trimNote
  domain.account            domain.organizations      domain.agents
  domain.missions           domain.tasks              domain.works
  domain.knowledge          domain.schedules          domain.runs
  domain.decisions          domain.communication      domain.connections
  domain.fleet              domain.billing            domain.activity
  check.title               check.dropzone            check.chooseFile
  check.privacyNote         check.reading             check.refused
  check.refusedDetail       check.formatTooNew        check.formatOlder
  check.wouldRestore        check.recordOnly          check.notPresent
  check.followUps           check.followUpCredentials check.followUpNodes
  check.followUpSchedules   check.nothingChanged      check.continueButton
  restore.title             restore.conflictsHeading  restore.strategySkip
  restore.strategyOverwrite restore.strategyRename    restore.applyButton
  restore.resultHeading     restore.resultPaused      restore.resultCredentials
  restore.resultSkipped     restore.resultRecordOnly
notifications.backupReady   notifications.backupPartial  notifications.backupFailed
dashboard.dangerZone.backupBanner.hasBackup
dashboard.dangerZone.backupBanner.noBackup
dashboard.dangerZone.backupBanner.action
metadata.pages.workspaceBackup
```

Numbers inside copy (`{limit}`, `{days}`, `{total}`, `{size}`, `{date}`, `{time}`, `{n}`,
`{section}`, `{done}`) are interpolation params read from the API's own configured values
(spec FR-47), never hard-coded in English strings.

The 20 sibling locale files in `apps/web/messages/` are seeded by the existing parity-sync
script, which must be run in the same change — a missing **parent** key collapses the whole
subtree for that locale.

---

## 9. Telemetry and failure modes

### 9.1 Telemetry

Emitted through the existing monitoring package; no new provider.

| Event / metric | Fields | Question it answers |
| --- | --- | --- |
| `workspace_backup_requested` | `includeFullHistory`, `adopted`, `refusedReason?` | How often is the daily allowance actually hit? |
| `workspace_backup_completed` | `durationMs`, `sizeBytes`, `recordCount`, `fileCount`, `omittedFileCount`, `domainsFailed` | Are the FR-14/FR-15 limits set at the right place? |
| `workspace_backup_failed` | `reason`, `domain?`, `durationMs` | Which failure dominates — stalls, timeouts, storage? |
| `workspace_backup_domain_duration` | `domain`, `ms`, `records` | Which domain to optimise first. |
| `workspace_backup_downloaded` | `ageHours`, `downloadCount` | Do people actually retrieve them, and how soon? |
| `workspace_backup_expired_undownloaded` | — | Is 14 days too short, or is nobody downloading? |
| `workspace_backup_checked` | `formatVersion`, `outcome` | Is the verify path used, and by whom? |
| `workspace_restore_applied` | `domains`, `conflicts`, `skipped`, `failedDomains` | Does restore work in the field? |

Activity-history entries (§3.4) carry the backup id, so a support conversation can start from the
workspace's own record.

### 9.2 Failure modes

| Mode | Detection | Behaviour | Spec |
| --- | --- | --- | --- |
| Job runtime not configured | Dispatcher returns `null` | Row → `failed` / `internal` immediately; card shows the unavailable copy | FR-46 |
| Storage backend unreachable | `putObject*` throws | 3 retries with backoff, then `failed` / `storage_unavailable`; allowance not charged | S-23 |
| One domain throws | Per-collector try/catch | 2 retries, then domain marked `failed`, archive still completes | FR-17, S-13 |
| Worker killed | No heartbeat for 10 min | Sweeper marks `stalled`, deletes the partial object | FR-5, S-14 |
| Job exceeds an hour | `maxDuration` | `failed` / `timeout` with copy that suggests turning off full history | FR-6 |
| Structured data over the ceiling | Running byte counter in the writer | Abort, `failed` / `too_large`, support path named | FR-16, S-12 |
| Attachment budget reached | Running byte counter | Stop adding files, keep going, list every omission | FR-15, S-11 |
| Two tabs press create | Partial unique index → conflict | Service catches the conflict and returns the running row with `adopted: true` | FR-3, S-9 |
| Stale download token | HMAC expiry check | `403`; client re-mints transparently | FR-12, S-15 |
| Foreign or corrupt manifest | Sentinel field check | `422 not_a_backup_manifest` naming the two fields looked for | S-18 |
| Newer format | Version compare | Described but not restorable, with that reason | FR-27, S-19 |
| Restore collides | Conflict detection before write | Per-item skip / overwrite / rename, default skip | FR-37, S-21 |
| Restore domain fails mid-way | Per-domain transaction | Roll back that domain only, report it | FR-38 |
| Expired archive requested | `status = expired` | `410` with the expiry date, not a `404` | S-16 |

---

## 10. Test plan

### 10.1 Unit — agent package (Jest, `packages/agent`)

| File | Covers |
| --- | --- |
| `packages/agent/src/account-transfer/backup/workspace-backup.service.spec.ts` **(new)** | Create/adopt semantics, the 3-per-24h allowance (including that failures do not count), cancel compare-and-set, expiry maths, download-token minting and rejection |
| `packages/agent/src/account-transfer/backup/workspace-backup-runner.spec.ts` **(new)** | The fifteen-domain walk against fixture repositories; a domain that throws twice is marked `failed` while the other fourteen complete; heartbeats are written; cancellation is observed between pages |
| `packages/agent/src/account-transfer/backup/backup-archive-writer.spec.ts` **(new)** | Zip layout matches §3.5; JSONL line counts match the manifest; `checksums.txt` verifies; the byte counters trip the FR-15 and FR-16 limits; two runs over unchanged fixtures differ only in timestamps |
| `packages/agent/src/account-transfer/backup/backup-manifest.spec.ts` **(new)** | Every one of the fifteen domains is present with a status; trims carry a cutoff and a count; the exclusions list carries all nine categories |
| `packages/agent/src/account-transfer/backup/redaction.spec.ts` **(new)** | Fixture rows for every secret-bearing entity emit no value; the reflection guard fails on an unhandled secret-shaped column |
| `packages/agent/src/account-transfer/backup/backup-verify.service.spec.ts` **(new)** | Sentinel rejection, older format accepted, newer format described-not-restorable, restorability classification |
| `packages/contracts/src/__tests__/backup-format.spec.ts` **(new)** — Vitest, this package's runner | `BACKUP_DOMAINS.length === 15`; every key has a collector id and a restorability class; the version constant parses. `index.barrel.spec.ts` is extended with the new `backup` area in the same change |

### 10.2 Controller spec — API (Jest, `apps/api`)

| File | Covers |
| --- | --- |
| `apps/api/src/account/workspace-backup.controller.spec.ts` **(new)** | All thirteen routes: owner-only gating (member → 403), cross-scope `404`, `202` on create, `200 + adopted` while running, `429` with `retryAt`, `503` with no storage, `410` on an expired download, `403` on a bad token, the 8 MiB verify cap, and that `BackupDto` never contains `storageKey`, `failureDetail` or `runtimeRunId` |
| `apps/api/src/account/account.controller.spec.ts` (existing) | Extended with one assertion that the legacy `GET /api/account/export` behaviour is byte-for-byte unchanged |

### 10.3 Unit — web (Vitest, `apps/web/vitest.config.ts`)

| File | Covers |
| --- | --- |
| `apps/web/src/components/settings/WorkspaceBackupCard.unit.spec.tsx` **(new)** | Each of the eleven states renders its §6.11 copy; no Create button during the loading state; disabled controls carry their reason |
| `apps/web/src/components/settings/useWorkspaceBackup.unit.spec.ts` **(new)** | 5 s → 15 s backoff, polling stops when hidden and refetches on show, the live-region string is throttled to 30 s |
| `apps/web/src/components/settings/BackupCheckPanel.unit.spec.tsx` **(new)** | Over-8-MiB and non-JSON files are refused **without** a network call; the refusal names both sentinel fields |
| `apps/web/src/app/api/account/backups/[id]/download/route.unit.spec.ts` **(new)** | Only `token` is forwarded; the scope selector is consumed, not relayed; the body is piped, not buffered; the fallback `Content-Disposition` is a constant |

### 10.4 E2E (Playwright, `apps/web/e2e/`)

| File | Covers |
| --- | --- |
| `apps/web/e2e/workspace-backup.spec.ts` **(new)** | Golden path: create → running → ready → the coverage drawer lists 15 sections → download returns a zip with the right content type. Plus: a second create adopts the first; a non-owner sees disabled controls; the danger-zone banner reflects the last backup |
| `apps/web/e2e/workspace-backup-check.spec.ts` **(new)** | Drop a good manifest → report; a foreign manifest → the named refusal; a newer-format manifest → described, restore refused |
| [`apps/web/e2e/account-data.spec.ts`](../../../../../apps/web/e2e/account-data.spec.ts) (existing) | Unchanged, and must stay green — it is the regression guard for the untouched export/import/sync path |

### 10.5 Guards that come for free

- `tasks.spec.ts` fails if `WORKSPACE_BACKUP_DISPATCHER` is not added to
  `TASKS_BARREL_RUNTIME_SYMBOLS`.
- `database.module.spec.ts` / `database.config.spec.ts` fail if the entity is registered in fewer
  than all of `entities/index.ts`, `_entity-names.ts` and `_entities-inventory.ts`.
- The i18n parity script fails CI if a locale is missing the new parent key.

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green.

### P1 — A complete archive you can download

Entity, migration, contract module, runner with all fifteen collectors, archive writer, manifest,
the streaming storage-contract extension, the create/list/get/current/cancel/delete/download-link
/download routes, the card with all its states, the history list, the coverage drawer, the danger
-zone banner, i18n, the published format documentation, and the sweeper cron.

**Ships:** spec FR-1 to FR-33, FR-41 to FR-47. **Does not ship:** verify, restore.
**Green because:** everything is new except two additive render calls, and the legacy export path
is untouched and still covered by its existing e2e.

### P2 — Check it, and restore what can be restored

The verify endpoint and the check panel; restore preview and apply for backups this workspace
already holds; the restore job with per-domain transactions, paused schedules and
`needs credential` connections; the result screen.

**Ships:** spec FR-34 to FR-40.
**Green because:** restore reuses `AccountImportService` for the domains it already handles and
adds appliers domain by domain, each behind its own test.

### P3 — Automatic backups and foreign archives

A weekly/monthly schedule per workspace (defaults settled by the §9 open question), retention of
the three most recent automatic archives independent of the manual allowance, notification-channel
fan-out on completion, an optional push into the existing config-repo sync, restore from an
uploaded archive, and a palette command from AW-01.

**Ships:** the deferred items in spec §7.3 and §7.5.
**Green because:** the schedule is one more `schedules.task` calling the same service the button
calls, and archive upload routes into the P2 restore path.

---

## 12. Constitution compliance

| Principle | Status | Justification |
| --- | --- | --- |
| **I. Plugin-first** | Pass | No external service is spoken to directly; the archive is written and read entirely through `IStoragePlugin`. The two new methods are optional additions to the existing contract, implemented inside the existing storage plugin packages — no inline client anywhere. |
| **II. Capability-driven resolution** | Pass | The backend is resolved by `getActiveStorageBackend()` and probed by capability (`putObjectStream` present or not). No plugin id appears in the runner, the service, the controller or the web layer. |
| **III. Source-of-truth repositories** | Pass | Work content is still read *from* the user's data repo through the existing `DataRepository` walk and snapshotted into the archive. The archive is a copy for the user, never a new source of truth, and nothing is written back into a repo. |
| **IV. Job runtime** | Pass | Every long-running piece — the archive build, the restore, the hourly sweeper — is dispatched through `WORKSPACE_BACKUP_DISPATCHER` / `WORKSPACE_RESTORE_DISPATCHER` and a `schedules.task`. No call site imports a vendor SDK; `POST /api/account/backups` returns `202` immediately. |
| **V. Forward-only migrations** | Pass | One additive create-table migration ships in the same PR as the entity (§3.3); no column is renamed, dropped or repurposed; `down()` drops only the new table. |
| **VI. Tests first-class** | Pass | Seven unit specs, two controller specs, four web unit specs and two e2e specs, listed by filename in §10, plus three CI drift guards that fail on a missing registration. |
| **VII. Privacy and secret hygiene** | Pass | Spec FR-18 is implemented as one redaction module with a reflection-based CI guard that fails when a new secret-shaped column is not covered; the archive carries field **names** only; download links are HMAC-signed, short-lived and account-bound; the encryption posture is stated to the user rather than implied. |
| **VIII. Single source of truth for plugin lists** | Pass | The two new storage capabilities are recorded in `docs/plugin-system/built-in-plugins.md` and nowhere else; no plugin count is repeated in this epic's documentation. |
| **IX. Behaviour-first specs** | Pass | `spec.md` names no class, file or library; every implementation detail lives here. |
| **X. Backwards compatibility** | Pass | The existing `GET /api/account/export` contract and both import routes are untouched and still asserted by their tests; the new routes live under a new path; the storage-contract additions are optional so no plugin major version is required; the archive format is explicitly versioned with defined read-old / refuse-newer behaviour (spec FR-27). |

### Program rules

| Rule | Status |
| --- | --- |
| 1 · Additive only | Pass — two render calls added, nothing removed or renamed |
| 2 · No duplicate nouns | Pass — one new noun (*Workspace backup*), justified in spec §5.1, added to the program vocabulary table in the same change |
| 3 · Behaviour-first spec | Pass |
| 4 · Plugin-first for anything external | Pass |
| 5 · Background work through the job runtime | Pass |
| 6 · Migration in the same PR | Pass |
| 7 · Tests as a prerequisite | Pass |
| 8 · i18n with camelCase, dot-free leaves | Pass — §8 |
| 9 · Every surface answers "what did it cost?" | N/A with a note — a backup spends no tokens and makes no model call. The card states the storage cost instead (size and retention), which is the only cost it has. |

## 13. References

- Spec: [spec.md](./spec.md) · Tasks: [tasks.md](./tasks.md)
- Program: [README.md](../README.md) · Substrate note **S10**: [EXISTING-SUBSTRATE.md](../EXISTING-SUBSTRATE.md)
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- House style: [`docs/specs/features/schedules/spec.md`](../../schedules/spec.md)
- Existing user documentation to link from: [`docs/features/data-management.md`](../../../../features/data-management.md)
