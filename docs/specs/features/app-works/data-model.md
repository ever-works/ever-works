# App Works — consolidated data model

**Status:** `Draft` · **Created:** 2026-09-17 · **Program:** [App Works](./README.md)
**Closes:** `SK-11` (no consolidated data model; `CONTRACTS.md` §2 misses three schema changes)
**Owner:** programme level. Each epic owns its own tables — this document only collects them, and the epic's
`plan.md` §"Data model" stays authoritative for columns and semantics.
**Companion documents:** [CONTRACTS.md](./CONTRACTS.md) §2 (entities and persisted state) · §3 (capability
ports) · [README.md](./README.md) §7 rule 6 (migration timestamps) · [TRACKER.md](./TRACKER.md) "Migration
timestamp blocks" · [CONFIGURATION.md](./CONFIGURATION.md) §5 (database-backed settings) ·
[quickstart.md](./quickstart.md) §7 (running migrations locally) · [`contracts/README.md`](./contracts/README.md)

---

## 0. How to read this document

**Authority order.** An epic's `plan.md` "Data model" section is normative for its own tables.
[CONTRACTS.md](./CONTRACTS.md) §2 is normative for **names and owners** shared across epics. This file is the
single place where all of them can be seen at once, with the migration each one reserves and how it is
classified for the workspace backup. Where this file and an epic's plan disagree, **the plan wins** and this
file has a bug — fix it here.

**Every table is additive.** README §7 rule 1 and Resolution **R-26** (additive-only, top priority): no
existing table, column, index or default is removed, renamed, narrowed or marked obsolete by this programme.
Every migration's `down()` drops exactly what its `up()` created — never more.

**Line numbers move.** The programme's epic documents are being edited while this document is written. Every
citation below was resolved against the working tree at the time of writing and carries the section heading
as well as the line, so a moved line is re-findable: search the heading, then re-stamp the number.

**Counts.** **19 new tables** and **9 extensions of existing tables**, across 23 reserved migrations in the
`1792<epic><slot>00000` block. APW-01 and APW-13 add no schema.

---

## 1. Inventory

`TS` = the reserved migration timestamp. `R-25` = how the table is classified for the workspace backup
(Resolution R-25): a `BACKUP_DOMAIN_SPECS` export file, an entry in `BACKUP_DROPPED_ENTITIES`, or
"rides an existing export".

### 1.1 New tables

| #   | Table                        | Owner  | TS                               | Migration file                          | R-25                                                                                    | Source                                                                    |
| --- | ---------------------------- | ------ | -------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | `work_upstream_states`       | APW-02 | `1792020000000`                  | `CreateWorkUpstreamStates.ts`           | export `data/works/upstream-states.jsonl`                                               | [`APW-02/plan.md`](./APW-02-fork-lifecycle/plan.md) §3.1 · migration §3.2 |
| 2   | `work_app_spec_states`       | APW-03 | `1792030000000`                  | `CreateWorkAppSpecStates.ts`            | export `data/works/app-spec-states.jsonl` (three `*Hash` columns benign)                | [`APW-03/plan.md`](./APW-03-app-spec-and-catalog/plan.md) §3.1 · §3.3     |
| 3   | `work_app_provisionings`     | APW-04 | `1792040000000`                  | `CreateWorkAppProvisionings.ts`         | export `data/works/app-provisionings.jsonl` (`tokenCap` benign)                         | [`APW-04/plan.md`](./APW-04-app-provisioner/plan.md) §3.1 · §3.4          |
| 4   | `work_builds`                | APW-05 | `1792050000000`                  | `CreateWorkBuilds.ts`                   | export `data/works/builds.jsonl`; `buildInputsHash` **dropped**                         | [`APW-05/plan.md`](./APW-05-builds/plan.md) §3.1 · §3.4                   |
| 5   | `work_build_preparations`    | APW-05 | `1792050000000` (same migration) | `CreateWorkBuilds.ts`                   | **NOT STATED** — see §9 item 1                                                          | [`APW-05/plan.md`](./APW-05-builds/plan.md) §3.1b                         |
| 6   | `work_app_runtime_states`    | APW-06 | `1792060100000`                  | `CreateWorkAppRuntimeStates.ts`         | export `data/works/app-runtime-states.jsonl`                                            | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §7.2 · §7.3              |
| 7   | `work_app_env_values`        | APW-07 | `1792070000000`                  | `CreateAppEnvAndDependencies.ts`        | export under `data/works/`; `valueEncrypted` → `{ wasSet }`, `valueBytes` dropped       | [`APW-07/plan.md`](./APW-07-app-env-and-dependencies/plan.md) §3.1 · §3.4 |
| 8   | `work_app_dependencies`      | APW-07 | `1792070000000` (same migration) | `CreateAppEnvAndDependencies.ts`        | export under `data/works/`; `configEncrypted`/`outputsEncrypted` → `{ wasSet }`         | [`APW-07/plan.md`](./APW-07-app-env-and-dependencies/plan.md) §3.2 · §3.4 |
| 9   | `upstream_pull_requests`     | APW-09 | `1792090000000`                  | `CreateUpstreamPullRequests.ts`         | export `data/works/upstream-pull-requests.jsonl`                                        | [`APW-09/plan.md`](./APW-09-upstream-pull-requests/plan.md) §3.1 · §3.2   |
| 10  | `apps_tier_gate_runs`        | APW-10 | `1792100000000`                  | `CreateAppsTierGate.ts`                 | **dropped**, with a reason                                                              | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                 |
| 11  | `apps_tier_attestations`     | APW-10 | `1792100000000`                  | `CreateAppsTierGate.ts`                 | **dropped**, with a reason                                                              | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                 |
| 12  | `apps_tier_state_events`     | APW-10 | `1792100000000`                  | `CreateAppsTierGate.ts`                 | **dropped**, with a reason                                                              | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                 |
| 13  | `apps_tier_quarantines`      | APW-10 | `1792100100000`                  | `CreateAppsTierQuarantineAndSignals.ts` | **dropped**, with a reason                                                              | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                 |
| 14  | `apps_tier_abuse_signals`    | APW-10 | `1792100100000`                  | `CreateAppsTierQuarantineAndSignals.ts` | **dropped**, with a reason                                                              | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                 |
| 15  | `apps_tier_image_allowances` | APW-10 | `1792100100000`                  | `CreateAppsTierQuarantineAndSignals.ts` | **dropped**, with a reason                                                              | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                 |
| 16  | `apps_tier_quota_profiles`   | APW-10 | `1792100200000`                  | `CreateAppsTierQuotaAndMetering.ts`     | **dropped**, with a reason                                                              | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                 |
| 17  | `apps_tier_usage_windows`    | APW-10 | `1792100200000`                  | `CreateAppsTierQuotaAndMetering.ts`     | record-only export `data/runs/apps-tier-usage-windows.jsonl` (`runs` domain, time trim) | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4                 |
| 18  | `app_launcher_preferences`   | APW-11 | `1792110000000`                  | `CreateAppLauncherPreferences.ts`       | export `data/account/app-launcher-preferences.jsonl`                                    | [`APW-11/plan.md`](./APW-11-app-launcher/plan.md) §3.2 · §3.4             |
| 19  | `external_identities`        | APW-12 | `1792120000000`                  | `CreateExternalIdentities.ts`           | **dropped** (a sign-in binding must never be restored)                                  | [`APW-12/plan.md`](./APW-12-ever-id/plan.md) §3.1 · §3.6                  |

### 1.2 Extensions of existing tables

| Table                                             | Owner  | TS              | What is added                                                                                                                      | R-25                                          | Source                                                        |
| ------------------------------------------------- | ------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `work_deployments`                                | APW-06 | `1792060000000` | 5 nullable columns: `buildId`, `componentStatuses`, `smokeResult`, `appTarget`, `appRender`                                        | rides the existing `deployments.jsonl`        | [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §7.1 · §7.3  |
| `tasks`                                           | APW-08 | `1792080000000` | 6 columns: `mergeCommitSha`, `deliveryState`, `deliveryBuildId`, `deliveryDeploymentId`, `deliveryUpdatedAt`, `deliveryClosedById` | rides the existing `data/tasks/tasks.jsonl`   | [`APW-08/plan.md`](./APW-08-evolve-loop/plan.md) §3.1         |
| `tasks`                                           | APW-08 | `1792110100000` | 1 column: `branchGuardRefusal` text NULL (added 2026-09-25; stamped outside the APW-08 block, see §4)                              | rides the existing `data/tasks/tasks.jsonl`   | [`APW-08/plan.md`](./APW-08-evolve-loop/plan.md) §3.5         |
| `goals`                                           | APW-08 | `1792080100000` | 1 column: `workId uuid NULL`                                                                                                       | rides `data/missions/goals.jsonl`             | [`APW-08/plan.md`](./APW-08-evolve-loop/plan.md) §3.2         |
| `missions`                                        | APW-08 | `1792080200000` | 3 columns: `outputMode`, `taskOutput`, `taskOutputNoticeAt`                                                                        | rides `data/missions/missions.jsonl`          | [`APW-08/plan.md`](./APW-08-evolve-loop/plan.md) §3.3         |
| `organizations`                                   | APW-04 | `1792040100000` | 1 column: `appProvisionCaps` (simple-json, nullable)                                                                               | rides `data/organizations/organization.jsonl` | [`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T41    |
| `works`                                           | APW-10 | `1792100200000` | 1 column: `appsTierQuotaProfile` varchar(32) NULL (`NULL` = `starter`)                                                             | rides `works/works.jsonl`                     | [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4     |
| `works`                                           | APW-11 | `1792110000000` | 1 column: `appLauncherExposed` boolean NULL (`NULL` = kind default)                                                                | rides `works.jsonl`                           | [`APW-11/plan.md`](./APW-11-app-launcher/plan.md) §3.1 · §3.4 |
| `session`                                         | APW-12 | `1792120100000` | 2 nullable columns: `externalIdentityId`, `externalSid` (+2 indexes)                                                               | already dropped with the session tables       | [`APW-12/plan.md`](./APW-12-ever-id/plan.md) §3.2 · §3.6      |
| `works.sourceRepository` (existing `simple-json`) | APW-01 | **none**        | additive keys only — `template` provenance block; no column, no migration                                                          | rides `works.jsonl`                           | [`APW-01/plan.md`](./APW-01-app-work-kind/plan.md) §3.1       |

**APW-01 reserves slot `1792010000000` and does not use it.** [`APW-01/plan.md`](./APW-01-app-work-kind/plan.md)
§3.1 states "**Migration: none.** Slot `1792010000000` (APW-01 slot 00) is reserved and unused". **APW-13 adds
no table, column or migration** ([`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §3).

**APW-12 adds no table for the OIDC replay store** — it reuses the existing `verification` table with
`identifier: 'ever-id:<kind>'` rows ([`APW-12/plan.md`](./APW-12-ever-id/plan.md) §3.3).

---

## 2. New tables — owner, columns, keys, retention

Every row below is a **key** column; the full column list is the cited section. Types are written exactly as
the plan writes them (`simple-json` = TypeORM `simple-json`, `bigint ts` = TypeORM `TimestampColumn`).

### 2.1 `work_upstream_states` — APW-02

Entity `WorkUpstreamState`, `packages/agent/src/entities/work-upstream-state.entity.ts` (new).

| Column                                                                       | Type                          | Default       | Note                                                                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                         | uuid PK                       |               |                                                                                                                                 |
| `workId`                                                                     | uuid, unique                  |               | `@ManyToOne(() => Work, { onDelete: 'CASCADE' })`                                                                               |
| `relation`                                                                   | varchar(16)                   |               | `link` · `fork` · `private-copy`                                                                                                |
| `dataOwner` / `dataRepo`                                                     | varchar(100)                  |               | Work Repository coordinates (canonical)                                                                                         |
| `upstreamOwner` / `upstreamRepo`                                             | varchar(100), null            |               | null for `link`                                                                                                                 |
| `upstreamDefaultBranch`                                                      | varchar(255), null            |               | updated on rename (FR-43)                                                                                                       |
| `readinessState`                                                             | varchar(24)                   | `'preparing'` | `preparing` · `ready` · `timed_out` · `failed` · `waiting_for_setup_pr`                                                         |
| `readinessReason`                                                            | varchar(48), null             |               | `access_revoked`, `dispatch_unavailable`, …                                                                                     |
| `readinessStartedAt` / `readinessHeartbeatAt`                                | bigint ts                     |               | heartbeat = the sweeper's liveness signal                                                                                       |
| `readinessDispatches`                                                        | int                           | `0`           | ≤ 3 automatic (FR-23)                                                                                                           |
| `readinessManualRetries` / `readinessManualWindowAt`                         | int / bigint ts               | `0` / null    | ≤ 3 per rolling hour (FR-19)                                                                                                    |
| `setupPullRequestUrl` / `setupPullRequestNumber`                             | varchar(500) / int, null      |               | from APW-01's handler outcome                                                                                                   |
| `copyPushedSha`                                                              | varchar(40), null             |               | private-copy idempotency (FR-21)                                                                                                |
| `aheadBy` / `behindBy`                                                       | int, null                     |               |                                                                                                                                 |
| `upstreamHeadSha`                                                            | varchar(40), null             |               |                                                                                                                                 |
| `syncSchedule` / `nextSyncAt`                                                | varchar(64) / bigint ts, null |               | effective cron; `nextSyncAt` null while paused                                                                                  |
| `lastSyncResult`                                                             | varchar(24), null             |               | `up_to_date` · `fast_forwarded` · `pull_request_opened` · `pull_request_updated` · `conflict` · `skipped` · `paused` · `failed` |
| `conflictTaskId`                                                             | uuid, null                    |               | **no FK** — a deleted Task must not cascade                                                                                     |
| `manualSyncCount` / `manualSyncWindowAt`                                     | int / bigint ts, null         | `0`           | ≤ 6 per rolling hour (FR-33)                                                                                                    |
| `upstreamStatus`                                                             | varchar(16)                   | `'unknown'`   | `available` · `archived` · `unavailable` · `none` · `unknown`                                                                   |
| `dataRepositoryStatus`                                                       | varchar(16)                   | `'available'` | `available` · `missing`                                                                                                         |
| `actionsState`                                                               | varchar(24)                   | `'pending'`   | `pending` · `clean` · `needs_admin` · `permission_missing` · `failed` · `not_applicable`                                        |
| `actionsSeenWorkflowIds`, `actionsDisabledWorkflows`, `actionsKeptWorkflows` | simple-json, null             |               | `number[]` ≤ 500; `{id,path}[]` ≤ 100 each                                                                                      |
| `tenantId` / `organizationId`                                                | uuid, null                    |               | scope stamping                                                                                                                  |
| `createdAt` / `updatedAt`                                                    | Create/UpdateDateColumn       |               |                                                                                                                                 |

- **Indexes / uniqueness:** `uq_work_upstream_states_work (workId)` UNIQUE · `idx_work_upstream_states_next_sync
(nextSyncAt)` · `idx_work_upstream_states_readiness (readinessState, readinessHeartbeatAt)`.
- **FK:** `works(id)` `ON DELETE CASCADE`.
- **Retention (R-25):** exports as `data/works/upstream-states.jsonl`, reached through the parent Work ids; no
  column is redacted.
- **Source:** [`APW-02/plan.md`](./APW-02-fork-lifecycle/plan.md) §3.1 "`work_upstream_states` — entity
  `WorkUpstreamState` (new)" · migration §3.2.

### 2.2 `work_app_spec_states` — APW-03

Entity `WorkAppSpecState`, `packages/agent/src/entities/work-app-spec-state.entity.ts` (new).

| Column                                                                | Type                            | Default       | Note                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                  | uuid PK                         |               |                                                                                                                         |
| `workId`                                                              | uuid NOT NULL                   |               | unique; CASCADE with `works.id`                                                                                         |
| `trackedBranch`                                                       | varchar(255) NOT NULL           |               |                                                                                                                         |
| `requestedSeq` / `startedSeq` / `evaluatedSeq`                        | bigint NOT NULL                 | `0`           | coalescing; pending ⇔ `evaluatedSeq < requestedSeq`                                                                     |
| `headCommitSha` / `headSpecHash`                                      | varchar(40) / varchar(64) NULL  |               | hash = sha256 of canonical JSON of `spec`                                                                               |
| `validationStatus`                                                    | varchar(24) NOT NULL            | `'missing'`   | `valid` · `valid_with_warnings` · `invalid` · `missing` · `unreadable`                                                  |
| `issues`                                                              | simple-json NULL                |               | `AppSpecIssue[]` ≤ 200                                                                                                  |
| `errorCount` / `warningCount` / `issuesTruncated`                     | int / boolean NOT NULL          | `0` / `false` |                                                                                                                         |
| `effectiveCommitSha` / `effectiveSpecHash`                            | varchar(40) / varchar(64) NULL  |               |                                                                                                                         |
| `effectiveSpec`                                                       | simple-json NULL                |               | **cache only** — the file at `effectiveCommitSha` is authoritative; holds no secret values                              |
| `lastEvaluationTrigger`                                               | varchar(24) NULL                |               | `created` · `push` · `pr_merged` · `manual` · `lazy` · `blueprint_applied` · `build`                                    |
| `blueprintId` / `blueprintVersion` / `blueprintRepo` / `blueprintSha` | varchar(64/32/128/40) NULL      |               |                                                                                                                         |
| `blueprintMatchSource`                                                | varchar(16) NULL                |               | `manifest` · `alias` · `fork` · `probe` · `explicit` · `file`                                                           |
| `blueprintApplyStatus`                                                | varchar(16) NULL                |               | `applying` · `applied` · `failed`                                                                                       |
| `licenseSpdx` / `licenseClass` / `licenseSource`                      | varchar(200/8/16) NULL          |               | `green` · `amber` · `red` · `unknown`                                                                                   |
| `licenseEvidence` / `licenseObligations`                              | simple-json NULL                |               | ≤ 20 paths each; `string[]`                                                                                             |
| `licenseRegistryHash` / `licenseRegistrySource`                       | varchar(64) / varchar(16) NULL  |               | `live` · `last_good` · `snapshot`                                                                                       |
| `attestation`                                                         | simple-json NULL                |               | `{ userId, attestedAt, spdx, class, textId, textSha256, commitSha }` — **the one** license attestation record (C3, R-3) |
| `sourceOfferRequired`                                                 | boolean NOT NULL                | `false`       |                                                                                                                         |
| `displayName` / `trademarkNotice`                                     | varchar(80) / varchar(500) NULL |               |                                                                                                                         |
| `protectedPaths`                                                      | simple-json NULL                |               | `string[]` ≤ 50 — agents may not modify                                                                                 |

- **Indexes / uniqueness:** `uq_work_app_spec_states_work (workId)` UNIQUE ·
  `idx_work_app_spec_states_blueprint (blueprintId, blueprintVersion)` ·
  `idx_work_app_spec_states_registry (licenseRegistryHash)`.
- **FK:** `works(id)` `ON DELETE CASCADE`.
- **Retention (R-25):** exports as `data/works/app-spec-states.jsonl`; the three `*Hash` columns are reviewed
  as benign digests.
- **Source:** [`APW-03/plan.md`](./APW-03-app-spec-and-catalog/plan.md) §3.1 · migration §3.3.

### 2.3 `work_app_provisionings` — APW-04

Entity `WorkAppProvisioning`, `packages/agent/src/entities/work-app-provisioning.entity.ts` (new).

| Column                                                                     | Type                                             | Note                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `id`                                                                       | uuid PK                                          |                                                                                        |
| `workId`                                                                   | uuid NOT NULL                                    | `@ManyToOne(() => Work, { onDelete: 'CASCADE' })`                                      |
| `userId`                                                                   | uuid NOT NULL                                    | starter; question recipient                                                            |
| `taskId` / `agentId`                                                       | uuid NULL                                        | **no FK** (entity-cycle rule)                                                          |
| `trigger`                                                                  | varchar(24)                                      | `auto-create` · `manual` · `chat` · `upstream-smoke` · `auto-upstream-smoke`           |
| `status`                                                                   | varchar(16)                                      | `queued` · `running` · `needs_input` · `succeeded` · `merged` · `failed` · `cancelled` |
| `step` / `stepStates`                                                      | varchar(16) / simple-json                        | step ids and per-step state                                                            |
| `detectionSource`                                                          | varchar(24) NULL                                 | `app-spec` · `compose` · `dockerfile` · `helm` · `descriptor-hint` · `auto`            |
| `attempts` / `attemptBudget` / `attemptsUsed`                              | simple-json / int                                | ≤ 9; budget default 3, advanced by compare-and-set                                     |
| `openInboxItemId`, `questionAskedAt`, `questionRemindedAt`                 | uuid / timestamptz NULL                          |                                                                                        |
| `questionReason` / `questionParams`                                        | varchar(24) / simple-json NULL                   | params carry **names only**, ≤ 1 KiB, secret-scanned                                   |
| `tokensUsed` / `tokenCap`                                                  | bigint NOT NULL                                  | cap default 3,000,000                                                                  |
| `runnerMinutesUsed` / `runnerMinuteCap`                                    | int NOT NULL                                     | cap default 240                                                                        |
| `activeMs`                                                                 | bigint NOT NULL                                  | deadline 8 h, frozen while parked                                                      |
| `parkedReason` / `parkedAt`                                                | varchar(24) / timestamptz NULL                   | `kill-switch` · `agent-paused` · `workspace-paused` · `scope-paused` (R-17 waits)      |
| `lastRunOutput`                                                            | text NULL                                        | last `provision-output` block ≤ 512 KiB; cleared once the guard reads it               |
| `verificationTargetKind`, `verificationNamespace`, `verificationExpiresAt` | varchar(16) / varchar(63) / timestamptz NULL     | sweeper input                                                                          |
| `suggestionState`, `suggestionUpstream`, `suggestedAt`, `suggestionBundle` | varchar(16/200) / timestamptz / simple-json NULL | bundle ≤ 256 KiB                                                                       |
| `lease` / `leaseExpiresAt`                                                 | varchar(36) / timestamptz NULL                   | step-executor CAS; lease 5 min                                                         |

- **Indexes / uniqueness:** `uq_work_app_provisionings_active` UNIQUE `(workId)` **partial**
  `WHERE status IN ('queued','running','needs_input')` · `uq_work_app_provisionings_task` UNIQUE `(taskId)`
  partial `WHERE taskId IS NOT NULL` · `idx_work_app_provisionings_user_status (userId, status)` ·
  `idx_work_app_provisionings_org_status (organizationId, status)` · `idx_work_app_provisionings_expiry
(verificationExpiresAt)` · `uq_work_app_provisionings_suggestion` UNIQUE `(suggestionUpstream)` partial
  `WHERE suggestionState = 'queued'`.
- **FK:** `works(id)` `ON DELETE CASCADE`.
- **Retention (R-25):** exports as `data/works/app-provisionings.jsonl`; `tokenCap` reviewed as benign;
  `Organization.appProvisionCaps` rides the existing organizations file.
- **Source:** [`APW-04/plan.md`](./APW-04-app-provisioner/plan.md) §3.1 · migration §3.4.

### 2.4 `work_builds` — APW-05

Entity `WorkBuild`, `packages/agent/src/entities/work-build.entity.ts` (new).

| Column                                              | Type                                              | Note                                                                                     |
| --------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `id`                                                | uuid PK                                           |                                                                                          |
| `workId`                                            | uuid NOT NULL                                     | FK `works.id` `ON DELETE CASCADE`                                                        |
| `number`                                            | int NOT NULL                                      | per-App-Work sequence from 1                                                             |
| `buildPluginId`                                     | varchar(64) NOT NULL                              |                                                                                          |
| `status` / `trigger`                                | varchar(16) NOT NULL                              | `queued`…`blocked` / `push` · `pull_request` · `manual` · `verification`                 |
| `blockedReason` / `blockedDetail`                   | varchar(40) / simple-json NULL                    | names and numbers only, ≤ 2 KiB                                                          |
| `branch` / `commitSha` / `pullRequestNumber`        | varchar(255) / varchar(40) / int NULL             |                                                                                          |
| `providerRunId` / `runAttempt`                      | varchar(64) NULL / int NOT NULL DEFAULT 1         |                                                                                          |
| `dispatchCorrelationId` / `dispatchedAt`            | uuid / timestamp NULL                             |                                                                                          |
| `appSpecHash` / `specValidAtCommit`                 | varchar(64) / boolean NULL                        | from `AppSpecService.getEffectiveSpec(workId, sha)`                                      |
| `buildInputsHash`                                   | varchar(64) NULL                                  | sha256 over (name, fingerprint) of the synced build values — **dropped from the backup** |
| `buildSecretNames` / `secretsSyncedAt`              | simple-json / timestamp NULL                      | `string[]` ≤ 50 — the `EW_` names this preparation wrote                                 |
| `runnerLabel` / `runnerClass`                       | varchar(64) / varchar(24) NULL                    | `github-public` · `github-private` · `github-larger` · `apps-builder`                    |
| `imageRepository` / `imageDigest` / `imageTags`     | varchar(255) / varchar(71) / simple-json NULL     | digest `sha256:<64>`; tags ≤ 3; never `latest`                                           |
| `digestConfirmed` / `secretCheck`                   | boolean NOT NULL DEFAULT false / varchar(16) NULL | `passed` · `failed` · `not_needed`                                                       |
| `deployable` / `notDeployableReason`                | boolean NOT NULL DEFAULT false / varchar(40) NULL |                                                                                          |
| `failureClass` / `failureDetail` / `failureExcerpt` | varchar(32) / simple-json NULL                    | classifier output; excerpt ≤ 20 lines × ≤ 300 chars, redacted                            |
| `verificationResult` / `verifiesBuildId`            | simple-json / uuid NULL                           | `{ componentsReady, jobs[] ≤ 10, smoke[] ≤ 50 }`                                         |
| `billableMinutes` / `checksBillableMinutes`         | int NULL                                          | R-9; the second is part of the first                                                     |
| `usageEventId` / `triggeredByUserId`                | uuid NULL                                         | the receipt (`plugin_usage_events.id`), **no FK**                                        |
| `tenantId` / `organizationId`                       | uuid NULL                                         | Tier A scope, stamped by the subscriber                                                  |

- **Indexes / uniqueness:** `uq_work_builds_work_number (workId, number)` UNIQUE ·
  `uq_work_builds_provider_run (buildPluginId, providerRunId, runAttempt)` UNIQUE — **deliberately not
  partial** (`providerRunId` NULLs are distinct on Postgres, SQLite and MySQL/MariaDB, so an unadopted Build
  never collides, and `upsert(conflictPaths)` works on every driver) ·
  `idx_work_builds_work_created (workId, createdAt)` · `idx_work_builds_work_commit (workId, commitSha)` ·
  `idx_work_builds_status_observed (status, lastObservedAt)`.
- **FK:** `works(id)` `ON DELETE CASCADE`.
- **Retention (R-25):** exports as `data/works/builds.jsonl`; secret-name and spec-hash columns reviewed as
  benign; `buildInputsHash` is dropped.
- **Source:** [`APW-05/plan.md`](./APW-05-builds/plan.md) §3.1 "`work_builds` — the new table" · migrations §3.3.

### 2.5 `work_build_preparations` — APW-05 (added 2026-09-17, `APW05-G03`)

Entity `WorkBuildPreparation` (new). Per-App-Work preparation state, one row per Work.

| Column                                                 | Type                                                | Note                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `id`                                                   | uuid PK                                             |                                                                                               |
| `workId`                                               | uuid NOT NULL                                       | FK `works.id` `ON DELETE CASCADE`, **UNIQUE** `uq_work_build_preparations_work`               |
| `buildPluginId`                                        | varchar(64) NOT NULL                                |                                                                                               |
| `buildInputsHash` / `secretsSyncedAt`                  | varchar(64) / timestamp NULL                        | sha256 over (name, fingerprint) of the last completed secret sync; written even with 0 values |
| `buildSecretNames`                                     | simple-json NULL                                    | `string[]` ≤ 50 — `EW_` names written and not removed                                         |
| `workflowSha256`                                       | varchar(64) NULL                                    | only after a matching read-back (FR-8)                                                        |
| `workflowState`                                        | varchar(24) NOT NULL DEFAULT `'none'`               | `none` · `committed` · `pullRequestOpen` · `editedByHand`                                     |
| `workflowPullRequestNumber` / `workflowPullRequestUrl` | int / varchar(512) NULL                             |                                                                                               |
| `webhookId` / `webhookState`                           | varchar(64) / varchar(24) NOT NULL DEFAULT `'none'` | `none` · `installed` · `skipped` · `permissionMissing`                                        |
| `runsEtag` / `runsCheckedAt`                           | varchar(128) / timestamp NULL                       | the run-discovery cursor                                                                      |
| `repositoryBlock`                                      | simple-json NULL                                    | `{ reason, detail, at }` — e.g. `actionsDisabled`                                             |
| `prepareSeq` / `lastPreparedAt`                        | int NOT NULL DEFAULT 0 / timestamp NULL             | coalescing marker                                                                             |
| `tenantId` / `organizationId`                          | uuid NULL                                           |                                                                                               |

- **Indexes / uniqueness:** `uq_work_build_preparations_work` UNIQUE `(workId)` — counted among the six
  indexes the shared migration creates.
- **FK:** `works(id)` `ON DELETE CASCADE`.
- **Retention (R-25):** **NOT STATED** — neither the APW-05 R-25 line nor its T45 task names this table. See
  §9 item 1; it is reported rather than invented.
- **Source:** [`APW-05/plan.md`](./APW-05-builds/plan.md) §3.1b
  "`work_build_preparations` — per-App-Work preparation state — **(added 2026-09-17, `APW05-G03`)**".

### 2.6 `work_app_runtime_states` — APW-06

Entity `WorkAppRuntimeState` (new). One row per App Work; the deploy target and everything teardown needs.

| Column                                                                                          | Type                               | Note                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                                            | uuid PK                            |                                                                                                                                                                                           |
| `workId`                                                                                        | uuid, unique, FK CASCADE           |                                                                                                                                                                                           |
| `target`                                                                                        | varchar(24)                        | `none` (default; R-12) · `your-cluster` · `ever-works-apps`                                                                                                                               |
| `targetSettings`                                                                                | simple-json                        | `{ namespaceOverride?, ingressClass?, tls, issuer?, storageClass?, networkIsolation: true, allowRoot: false, managedSubdomain: true, primaryDomain?, autoDeploy: true, previews: false }` |
| `namespace`                                                                                     | varchar(63), null                  | frozen at the first `prepare-namespace` per `clusterFingerprint`                                                                                                                          |
| `clusterFingerprint`                                                                            | varchar(32), null                  | from `parseKubeconfig`; never written by a cluster-check                                                                                                                                  |
| `clusterCheck` / `clusterCheckedAt`                                                             | simple-json / timestamptz          | secret-free result incl. its own fingerprint and observed `ingressAddress`                                                                                                                |
| `currentDeploymentId`                                                                           | uuid, null                         |                                                                                                                                                                                           |
| `deployLockId` / `deployLockedAt`                                                               | uuid / timestamptz                 | atomic claim; stale after 7 260 s                                                                                                                                                         |
| `cancelRequestedAt` / `cancelRequestedByUserId`                                                 | timestamptz / uuid, null           | honoured only while the lock still holds the same Deployment id                                                                                                                           |
| `queuedBuildId` / `queuedDeploymentId`                                                          | uuid, null                         | latest-wins queue of 1                                                                                                                                                                    |
| `pendingDomainRebuildBuildId`                                                                   | uuid, null                         | Build requested by a `rebuild` domain change                                                                                                                                              |
| `upstreamSyncJudgedToSha`                                                                       | varchar(40), null                  | APW-04 FR-51                                                                                                                                                                              |
| `paused` / `pausedAt` / `removedAt`                                                             | boolean / timestamptz              |                                                                                                                                                                                           |
| `deletionRequestedAt` / `deletionDeleteData` / `deletionAttempts` / `deletionRequestedByUserId` | timestamptz / boolean / int / uuid | R-15 deletion in progress                                                                                                                                                                 |
| `ingressAddress` / `isolationEnforced`                                                          | simple-json / boolean, null        | `{ ip?, hostname? }`                                                                                                                                                                      |
| `health`                                                                                        | varchar(16)                        | `unknown` · `healthy` · `degraded` · `down` · `unreachable`                                                                                                                               |
| `consecutiveFailures` / `consecutivePasses` / `unreachableStreak`                               | int                                |                                                                                                                                                                                           |
| `lastHealthNotifiedAt` / `lastPolledAt` / `certInvalidSince`                                    | timestamptz                        |                                                                                                                                                                                           |
| `statusSnapshot` / `statusObservedAt`                                                           | simple-json / timestamptz          | `AppStatusSnapshot`, no log text                                                                                                                                                          |
| `tenantId` / `organizationId`                                                                   | uuid, null                         | scope columns, no relation decorators                                                                                                                                                     |

- **Indexes / uniqueness:** unique `workId`; `(target, paused, lastPolledAt)` for the poller; `(deployLockId)`;
  `(deletionRequestedAt)`. **No index names are given** by the plan.
- **FK:** `workId` keeps `ON DELETE CASCADE` — the row disappears only after APW-06 §9.7 has removed the
  workloads and APW-01 deletes the Work, so nothing needed for teardown is gone before it runs.
- **Retention (R-25):** exports as `data/works/app-runtime-states.jsonl`; nothing is redacted.
- **Source:** [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §7.2 "`work_app_runtime_states` _(new)_ — entity
  `WorkAppRuntimeState`" · migrations §7.3.

### 2.7 `work_app_env_values` — APW-07

Entity `WorkAppEnvValue` (new). **Secret-bearing.**

| Column                        | Type                   | Note                                                                       |
| ----------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `id`                          | uuid PK                |                                                                            |
| `workId`                      | uuid NOT NULL          | FK `works.id` `ON DELETE CASCADE`                                          |
| `name`                        | varchar(128) NOT NULL  | `^[A-Z_][A-Z0-9_]{0,127}$`                                                 |
| `origin`                      | varchar(16) NOT NULL   | `generated` · `prompted` · `user` · `derived` (keypair public halves only) |
| `valueEncrypted`              | text NOT NULL          | `enc::v1::` envelope; refused when encryption is not enabled               |
| `valueBytes`                  | int NOT NULL           | byte length for the 1 MiB total (FR-31); never shown                       |
| `version`                     | int NOT NULL DEFAULT 1 | +1 on every change; drives change flags and build fingerprints             |
| `generatorFingerprint`        | varchar(160) NULL      | canonical generate block, e.g. `"base64:24"`, `"keypair:ed25519"`          |
| `derivedFromName`             | varchar(128) NULL      | for `<NAME>_PUBLIC` rows                                                   |
| `generatedAt` / `setByUserId` | timestamp / uuid NULL  |                                                                            |

- **Indexes / uniqueness:** `uq_work_app_env_values_work_name` UNIQUE `(workId, name)` ·
  `idx_work_app_env_values_work (workId)`.
- **FK:** `works(id)` `ON DELETE CASCADE`.
- **Retention (R-25):** exports under `data/works/` through the parent Work ids with `valueEncrypted`
  redacted to `{ wasSet }` and `valueBytes` dropped. The table does **not** join `BACKUP_DROPPED_ENTITIES`.
- **Source:** [`APW-07/plan.md`](./APW-07-app-env-and-dependencies/plan.md) §3.1 · migration §3.4 ·
  R-25 line in §3.

### 2.8 `work_app_dependencies` — APW-07

Entity `WorkAppDependency` (new). **Secret-bearing.**

| Column                                                                                         | Type                                    | Note                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                                           | uuid PK                                 |                                                                                                                                       |
| `workId`                                                                                       | uuid NOT NULL                           | FK `works.id` `ON DELETE CASCADE`                                                                                                     |
| `kind`                                                                                         | varchar(16) NOT NULL                    | `postgres` · `redis` · `objectStorage` · `smtp`                                                                                       |
| `deployTarget`                                                                                 | varchar(24) NOT NULL                    | `your-cluster` · `ever-works-apps`                                                                                                    |
| `providerPluginId` / `providerId`                                                              | varchar(64) NOT NULL                    |                                                                                                                                       |
| `status`                                                                                       | varchar(16) NOT NULL                    | `pending` · `provisioning` · `ready` · `degraded` · `failed` · `kept` · `deleting` · `deleted`                                        |
| `statusReason` / `statusDetail`                                                                | varchar(48) / simple-json NULL          | names and numbers only, ≤ 2 KiB                                                                                                       |
| `declared`                                                                                     | simple-json NOT NULL                    | the App spec block for this kind (non-secret)                                                                                         |
| `actualVersion` / `sizeGiB`                                                                    | varchar(32) / int NULL                  |                                                                                                                                       |
| `configEncrypted` / `outputsEncrypted`                                                         | text NULL                               | prompted provider config; all outputs as one JSON envelope. **Always NULL for `ever-works-apps` rows** (resolved in the zone)         |
| `outputsVersion`                                                                               | int NOT NULL DEFAULT 0                  |                                                                                                                                       |
| `resourceRefs`                                                                                 | simple-json NULL                        | `{ namespace?, objects: [{kind,name}] ≤ 20, databases?, buckets? }` — non-secret                                                      |
| `inSpec`                                                                                       | boolean NOT NULL DEFAULT true           |                                                                                                                                       |
| `backupPolicy` / `backupState`                                                                 | varchar(16) NOT NULL / varchar(16) NULL | `none` · `operator` · `provider` · `managed` / `none` · `not_configured` · `healthy` · `overdue` · `failing` · `external` · `unknown` |
| `lastBackupAt`, `backupCheckedAt`, `lastProvisionedAt`, `lastCheckedAt`, `provisionLeaseUntil` | timestamp NULL                          |                                                                                                                                       |

- **Indexes / uniqueness:** `uq_work_app_dependencies_active` UNIQUE `(workId, kind)` **partial**
  `WHERE status NOT IN ('kept','deleted')` · `idx_work_app_dependencies_work (workId)` ·
  `idx_work_app_dependencies_status (status, lastCheckedAt)`.
- **FK:** `works(id)` `ON DELETE CASCADE` — removes rows when an App Work row is deleted; the data in clusters
  and tenant servers is untouched by that (FR-45). Kept rows are the record of what remains.
- **Retention (R-25):** `configEncrypted` and `outputsEncrypted` redacted to `{ wasSet }`.
- **Source:** [`APW-07/plan.md`](./APW-07-app-env-and-dependencies/plan.md) §3.2 · migration §3.4.

### 2.9 `upstream_pull_requests` — APW-09

Entity `UpstreamPullRequest` (new).

| Column                                                            | Type                                    | Note                                                                             |
| ----------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `id`                                                              | uuid PK                                 |                                                                                  |
| `userId`                                                          | uuid NOT NULL                           | author member; CASCADE with `user.id`                                            |
| `workId`                                                          | uuid NOT NULL                           | CASCADE with `works.id`                                                          |
| `sourceTaskId`                                                    | uuid NOT NULL                           | **no FK** — a Task deletion must not erase a published PR's record               |
| `preparationTaskId` / `followUpTaskId`                            | uuid NULL                               |                                                                                  |
| `upstreamOwner` / `upstreamRepo` / `baseBranch`                   | varchar(100/100/255)                    |                                                                                  |
| `headOwner` / `headRepo` / `headBranch` / `headSha`               | varchar(100/100/255) / varchar(64) NULL | branch `upstream-pr/{slug≤40}-{4 hex}`                                           |
| `state`                                                           | varchar(24) NOT NULL                    | `UPSTREAM_PULL_REQUEST_STATES`; default `preparing`                              |
| `number` / `url`                                                  | int / varchar(512) NULL                 |                                                                                  |
| `title` / `body` / `disclosureText`                               | varchar(200) / text / varchar(300) NULL | public text by design                                                            |
| `maintainerCanModify`                                             | boolean NOT NULL DEFAULT true           |                                                                                  |
| `approvalProposalId` / `approvalExpiresAt`                        | uuid / timestamptz NULL                 |                                                                                  |
| `checksSummary` / `reviewSummary` / `signatureState`              | varchar(32/24/24) NULL                  | `cla_required` · `cla_acknowledged` · `cla_pending_check`                        |
| `refusalCode` / `refusalDetail`                                   | varchar(32) / varchar(500) NULL         | detail is a quoted guide sentence ≤ 300 or a provider message, **never a token** |
| `diffStats` / `checkResults` / `seenReviewIds` / `pushTimestamps` | simple-json NULL                        | ≤ 10 checks; ≤ 200 review ids; ≤ 20 push times (24 h window)                     |
| `lastUpstreamActivityAt` / `lastCheckedAt` / `nextCheckAt`        | timestamptz NULL                        |                                                                                  |
| `openedAt` / `mergedAt` / `closedAt`                              | timestamptz NULL                        |                                                                                  |

- **Indexes / uniqueness:** `idx_upr_work_state (workId, state)` ·
  `idx_upr_user_upstream_opened (userId, upstreamOwner, upstreamRepo, openedAt)` ·
  `idx_upr_due (state, nextCheckAt)` · `uq_upr_active_source (sourceTaskId)` UNIQUE **partial**
  `WHERE state IN ('preparing','needs_signature','awaiting_approval','opening','open')` (FR-5, S27).
- **FK:** CASCADE with `user.id` and with `works.id`.
- **Retention (R-25):** exports as `data/works/upstream-pull-requests.jsonl`; nothing is redacted.
- **Source:** [`APW-09/plan.md`](./APW-09-upstream-pull-requests/plan.md) §3.1 · migration §3.2.

### 2.10 The `apps_tier_*` tables — APW-10

Eight tables in `packages/agent/src/entities/`, registered in the new
`packages/agent/src/apps-tier/apps-tier.module.ts`. **Raw uuid references, no `@ManyToOne` across families**
(the EW-654 rule, as in `fleet-kill-switch.entity.ts`) — so **no FK and no `ON DELETE` is stated for any of
them**, deliberately.

| Table                        | Columns (as the plan lists them)                                                                                                                                                                                                                                                                                                                                                        | Index / unique                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps_tier_gate_runs`        | `id`, `trigger` (`manual`/`schedule`), `requestedByUserId?`, `status` (`running`/`green`/`red`/`error`), `scope` (`verified-blueprints`/`any`), `results` simple-json (≤ 25 rows `{id,outcome,reasonCode,durationMs}`), `policyRevision?`, `controllerVersion?`, `gateVersion`, `startedAt`, `finishedAt?`                                                                              | `(status, finishedAt)`                                                                                                            |
| `apps_tier_attestations`     | `id`, `itemId` varchar(8), `attestedByUserId`, `evidenceNote` text (20–2 000), `evidenceRef` varchar(500)?, `attestedAt`, `expiresAt`, `revokedAt?`, `revokedByUserId?`, `revokeReason?`, `notified14dAt?`, `notified1dAt?`                                                                                                                                                             | `(itemId, expiresAt)`                                                                                                             |
| `apps_tier_state_events`     | append-only: `id`, `state` (`closed`/`open-verified-blueprints`/`open-any`), `actor` (`user`/`system`), `actorUserId?`, `reason` varchar(500), `reasonCodes` simple-json, `gateRunId?`, `automatic` bool, `createdAt`                                                                                                                                                                   | `(createdAt)`                                                                                                                     |
| `apps_tier_quarantines`      | `id`, `workId`, `requestId` uuid unique, `category`, `source` (`operator`/`detector`/`pause-all`/`self-check`), `reason` varchar(500), `requestedByUserId?`, `requestedAt`, `networkIsolatedAt?`, `scaledToZeroAt?`, `ingressDisabledAt?`, `state` (`requested`/`active`/`releasing`/`released`), `releasedByUserId?`, `releaseReason?`, `releasedAt?`, `signalId?`, `pauseAllBatchId?` | **partial unique** `(workId) WHERE state IN ('requested','active','releasing')`; the SQLite branch uses a unique expression index |
| `apps_tier_abuse_signals`    | `id`, `workId`, `zoneName` unique, `kind`, `severity`, `observedAt`, `summary` varchar(500), `ruleId`, `test` bool, `status` (`open`/`dismissed`/`actioned`), `handledByUserId?`, `handledReason?`, `autoQuarantined` bool, `createdAt`                                                                                                                                                 | `(status, severity)`                                                                                                              |
| `apps_tier_quota_profiles`   | `name` PK varchar(32), `limits` simple-json (FR-47 fields), `monthlyEgressGiB`, `buildMinutesMonthly`, `updatedByUserId?`, `updatedAt`; seeded `starter`, `standard`                                                                                                                                                                                                                    | PK `name`                                                                                                                         |
| `apps_tier_image_allowances` | `id`, `workId`, `digest` char(71), `reason`, `createdByUserId`, `expiresAt` (≤ 30 days), `createdAt`                                                                                                                                                                                                                                                                                    | UNIQUE `(workId, digest)`                                                                                                         |
| `apps_tier_usage_windows`    | `id`, `workId`, `windowStart`, `unit` (`cpu_core_seconds`/`memory_mib_hours`/`egress_mib`/`storage_gib_hours`/`build_minutes`), `quantity` bigint, `pluginUsageEventId`, `createdAt`                                                                                                                                                                                                    | UNIQUE `(workId, windowStart, unit)` (FR-50)                                                                                      |

- **Retention (R-25):** the **seven operator tables** join `BACKUP_DROPPED_ENTITIES` under one comment giving
  the reason — operator launch-gate, moderation and quota state that is not stored on a workspace's behalf
  (detector rules, operator reasons and operator ids never reach a tenant). `AppsTierUsageWindow` exports
  **record-only** as `data/runs/apps-tier-usage-windows.jsonl` through the parent Work ids with its time trim.
  `Work.appsTierQuotaProfile` rides `works/works.jsonl`.
- **Seeding:** `1792100000000` seeds exactly **one** `closed` state event (`actor: system`,
  `reason: 'initial'`) so "no row" can only mean "migration not applied" and is read as **closed** — the
  fleet kill-switch posture. `1792100200000` seeds the quota profiles.
- **Source:** [`APW-10/plan.md`](./APW-10-apps-hosting-tier/plan.md) §4 "Platform data model" · migrations §4.

### 2.11 `app_launcher_preferences` — APW-11

Entity `AppLauncherPreference` (new), `packages/agent/src/entities/app-launcher-preference.entity.ts`.

| Column                    | Type                    | Note                                           |
| ------------------------- | ----------------------- | ---------------------------------------------- |
| `id`                      | uuid PK                 |                                                |
| `userId`                  | uuid NOT NULL           | FK `user.id` `ON DELETE CASCADE`               |
| `scopeKey`                | varchar(40) NOT NULL    | `'global'` · `'personal'` · `<organizationId>` |
| `itemKey`                 | varchar(64) NOT NULL    | `'platform:<catalogId>'` · `'work:<uuid>'`     |
| `visible` / `pinned`      | boolean NOT NULL        | defaults `true` / `false`                      |
| `pinOrder` / `sortOrder`  | smallint / integer NULL | `0..5` when pinned; `0..9999`                  |
| `createdAt` / `updatedAt` | timestamptz NOT NULL    |                                                |

- **Indexes / uniqueness:** `uq_app_launcher_prefs_user_scope_item` UNIQUE `(userId, scopeKey, itemKey)` ·
  `idx_app_launcher_prefs_user_scope (userId, scopeKey)`.
- **Deliberate omissions, all three normative:** **`scopeKey` instead of a nullable `organizationId`** —
  uniqueness over a nullable column is not portable (Postgres treats NULLs as distinct and so does SQLite);
  **no `tenantId`/`organizationId` stamp columns** — the scope subscriber would stamp the active Organization
  onto `global` rows, which would be wrong; **no FK to `works`** — item keys are polymorphic and rows for
  deleted or inaccessible Works are ignored on read (FR-28).
- **Retention (R-25):** exports in the account section as `data/account/app-launcher-preferences.jsonl`,
  scoped by user.
- **Source:** [`APW-11/plan.md`](./APW-11-app-launcher/plan.md) §3.2 · migration §3.4.

### 2.12 `external_identities` — APW-12

Entity `ExternalIdentity` (new), Tier B. **Dropped from the workspace backup.**

| Column                     | Type                      | Note                                                           |
| -------------------------- | ------------------------- | -------------------------------------------------------------- |
| `id`                       | uuid PK                   |                                                                |
| `userId`                   | uuid NOT NULL             | `@ManyToOne(() => User, { onDelete: 'CASCADE' })` (FR-30)      |
| `issuer`                   | varchar(512) NOT NULL     | exact `iss` string                                             |
| `subject`                  | varchar(255) NOT NULL     | exact `sub`                                                    |
| `emailAtLink`              | varchar(320) NOT NULL     | display only; **never** used to resolve an account             |
| `emailVerifiedAtLink`      | boolean NOT NULL          | always `true` for rows this epic writes                        |
| `linkedVia`                | varchar(16) NOT NULL      | `sign-up` · `settings`                                         |
| `linkedAt` / `lastLoginAt` | PortableDateColumn / NULL |                                                                |
| `delegatedClients`         | simple-json NULL          | `Array<{ clientId, lastSeenAt }>` ≤ 10, oldest evicted (FR-48) |
| `tenantId`                 | uuid NULL                 | Tier B scope stamp; **no** `organizationId`                    |

- **Indexes / uniqueness:** `uq_external_identities_issuer_subject` UNIQUE `(issuer, subject)` — the S24 race
  is decided by this index · `uq_external_identities_user_issuer` UNIQUE `(userId, issuer)` ·
  `idx_external_identities_user (userId)`.
- **FK:** `user.id` `ON DELETE CASCADE`.
- **Retention (R-25):** joins `BACKUP_DROPPED_ENTITIES` beside the session tables — an issuer + subject link
  is a sign-in binding, and a restore must never re-link an account to an identity.
- **Source:** [`APW-12/plan.md`](./APW-12-ever-id/plan.md) §3.1 · migrations §3.6.

---

## 3. Extensions of existing tables

### 3.1 `work_deployments` — APW-06

| Column              | Type                    | Meaning                                                                                                                                                                          |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildId`           | uuid, null, **indexed** | `WorkBuild.id` deployed — **no FK**, to keep APW-05's merge order free (validated in code). Null for `build.strategy: image`                                                     |
| `componentStatuses` | simple-json, null       | `[{ name, role, desired, ready, restarts, lastTerminationReason?, oomKilledAt? }]` at terminal state                                                                             |
| `smokeResult`       | simple-json, null       | `{ inCluster: CheckResult[], public: CheckResult[], hairpin?, classification?, observedAt }`                                                                                     |
| `appTarget`         | varchar(24), null       | `your-cluster` · `ever-works-apps`                                                                                                                                               |
| `appRender`         | simple-json, null       | phase, namespace, spec commit, env checksum, image ref/digest, job results, warnings, preconditions, rollback facts, cancelled/superseded markers — **never values or log text** |

New `WorkDeployment` states: `DEPLOYING`, `VERIFYING`, `ROLLED_BACK`, `SUPERSEDED`; `isTerminal()` adds
`ROLLED_BACK` and `SUPERSEDED`. Migration `1792060000000-ExtendWorkDeploymentsForApps.ts` adds the five
nullable columns and the index on `buildId`; `down()` drops only them.

**Source:** [`APW-06/plan.md`](./APW-06-app-runtime/plan.md) §7.1 · §7.3.

### 3.2 `tasks` — APW-08

| Column                 | Type             | Default | Why                                                                           |
| ---------------------- | ---------------- | ------- | ----------------------------------------------------------------------------- |
| `mergeCommitSha`       | varchar(64) NULL | NULL    | the commit a Build/Deployment must contain                                    |
| `deliveryState`        | varchar(24) NULL | NULL    | one of `TASK_DELIVERY_STATES`; `NULL` = not tracked (every existing Task)     |
| `deliveryBuildId`      | uuid NULL        | NULL    | `work_builds.id` that decided the state — no FK                               |
| `deliveryDeploymentId` | uuid NULL        | NULL    | `work_deployments.id` that decided it — no FK                                 |
| `deliveryUpdatedAt`    | timestamptz NULL | NULL    | reconciler ordering and stale detection                                       |
| `deliveryClosedById`   | uuid NULL        | NULL    | who chose **Close anyway**                                                    |
| `branchGuardRefusal`   | text NULL        | NULL    | why the change rules refused a change that reached the remote (≤ 4,000 chars) |

Indexes: `idx_tasks_delivery_due (deliveryState, deliveryUpdatedAt)` and `uq_tasks_work_merge_commit
(workId, mergeCommitSha)` UNIQUE **partial** `WHERE "mergeCommitSha" IS NOT NULL` — makes "merge recorded
once" (S29) a database guarantee. Migrations `1792080000000-AddTaskDeliveryState.ts`,
`1792080100000-AddGoalWorkScope.ts`, `1792080200000-AddMissionTaskOutput.ts`; `branchGuardRefusal` is added by
`1792110100000-AddTaskBranchGuardRefusal.ts` (added 2026-09-25, see §4).

### 3.3 `goals` — APW-08

`workId uuid NULL` + `idx_goals_work (workId)`. **No FK and no `@ManyToOne`** (the entity's cycle-avoidance
rule); deletion is detected by the orchestrator (S26).

### 3.4 `missions` — APW-08

`outputMode varchar(8) NOT NULL DEFAULT 'ideas'`, `taskOutput simple-json NULL`,
`taskOutputNoticeAt timestamptz NULL`. `taskOutput` is `{ tasksPerTick: 1..3 (1), openTasksCap: 1..10 (3),
agentId?: uuid }`, read through `normalizeMissionTaskOutput` on every use (fails toward the defaults).

### 3.5 `organizations.appProvisionCaps` — APW-04

Nullable `simple-json` `{ tokenCap?, runnerMinuteCap? }` on
`packages/agent/src/entities/organization.entity.ts`; accepted by
`apps/api/src/organizations/dto/update-organization.dto.ts` within APW-04 plan §3.2 bounds; resolved
**Organization → instance env → default**. Migration
`1792040100000-AddOrganizationAppProvisionCaps.ts` adds the one nullable column.
**Source:** [`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T41.

### 3.6 `works.appsTierQuotaProfile` and `works.appLauncherExposed` — APW-10 · APW-11

| Column                 | Type             | Default                                                     | Why                                                                                                                                       |
| ---------------------- | ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `appsTierQuotaProfile` | varchar(32) NULL | `NULL` = `starter`                                          | APW-10's per-Work quota profile                                                                                                           |
| `appLauncherExposed`   | boolean NULL     | `NULL` = kind default (`true` for `app`, `false` otherwise) | APW-11 FR-19; an explicit value always wins. Declared with an explicit `type: 'boolean'` because nullable union types reflect as `Object` |

### 3.7 `session` — APW-12

| Column               | Type                 | Why                                                             |
| -------------------- | -------------------- | --------------------------------------------------------------- |
| `externalIdentityId` | uuid NULL, **no FK** | sessions opened by an identity (disconnect, `sub`-only notices) |
| `externalSid`        | varchar(255) NULL    | Ever ID `sid` (notices with `sid`)                              |

Indexes `idx_session_external_identity` and `idx_session_external_sid`. No FK on purpose: a session row must
never block deleting an identity, and disconnect deletes the sessions explicitly first. Better Auth's own
adapter never writes these columns; `NULL` is the default for every other sign-in method (FR-35).

---

## 4. Migrations — the block, the sequence and the re-stamp rule

README §7 rule 6 fixes the timestamp shape: **`1792` + two-digit epic + two-digit slot + `00000`**. The
newest migration on `develop` when the programme was authored was
`1791200100000-CreateOnboardingChecklists.ts`; re-verified on `ee45946e5` it is
`1791240000000-AddSafetyRailsCore.ts`. Every reserved `1792…` timestamp is above it.

| Order | File                                                                                               | Epic   | Slot            |
| ----- | -------------------------------------------------------------------------------------------------- | ------ | --------------- |
| —     | _(reserved, unused)_                                                                               | APW-01 | `1792010000000` |
| 1     | `1792020000000-CreateWorkUpstreamStates.ts`                                                        | APW-02 | 00              |
| 2     | `1792030000000-CreateWorkAppSpecStates.ts`                                                         | APW-03 | 00              |
| 3     | `1792040000000-CreateWorkAppProvisionings.ts`                                                      | APW-04 | 00              |
| 4     | `1792040100000-AddOrganizationAppProvisionCaps.ts`                                                 | APW-04 | 01              |
| 5     | `1792050000000-CreateWorkBuilds.ts` (**two** tables: `work_builds`, `work_build_preparations`)     | APW-05 | 00              |
| 6     | `1792050100000-AddWorkBuildSupplyChain.ts` (`scanSummary`, `signatureState`, `blockedEgressHosts`) | APW-05 | 01              |
| 7     | `1792060000000-ExtendWorkDeploymentsForApps.ts`                                                    | APW-06 | 00              |
| 8     | `1792060100000-CreateWorkAppRuntimeStates.ts`                                                      | APW-06 | 01              |
| 9     | `1792070000000-CreateAppEnvAndDependencies.ts` (**two** tables)                                    | APW-07 | 00              |
| 10    | `1792080000000-AddTaskDeliveryState.ts`                                                            | APW-08 | 00              |
| 11    | `1792080100000-AddGoalWorkScope.ts`                                                                | APW-08 | 01              |
| 12    | `1792080200000-AddMissionTaskOutput.ts`                                                            | APW-08 | 02              |
| 13    | `1792090000000-CreateUpstreamPullRequests.ts`                                                      | APW-09 | 00              |
| 14    | `1792100000000-CreateAppsTierGate.ts`                                                              | APW-10 | 00              |
| 15    | `1792100100000-CreateAppsTierQuarantineAndSignals.ts`                                              | APW-10 | 01              |
| 16    | `1792100200000-CreateAppsTierQuotaAndMetering.ts`                                                  | APW-10 | 02              |
| 17    | `1792110000000-CreateAppLauncherPreferences.ts`                                                    | APW-11 | 00              |
| 17a   | `1792110100000-AddTaskBranchGuardRefusal.ts` (1 column on `tasks`: `branchGuardRefusal text NULL`) | APW-08 | 11/01           |
| 18    | `1792120000000-CreateExternalIdentities.ts`                                                        | APW-12 | 00              |
| 19    | `1792120100000-AddExternalIdentityToSessions.ts`                                                   | APW-12 | 01              |
| —     | _(none)_                                                                                           | APW-13 | —               |

**Row 17a (added 2026-09-25).** `1792110100000-AddTaskBranchGuardRefusal.ts` belongs to APW-08 but is stamped after
APW-11's `1792110000000` by coordinator direction, because APW-08's slots `1792080000000`–`1792080300000` stay reserved
for their planned migrations. It is one nullable `ADD COLUMN` with no dependency on anything APW-11 did, and it rides
the existing `data/tasks/tasks.jsonl` export.

**The re-stamp procedure (binding).** Every plan repeats it and every task carries it:

1. Generate the skeleton with the repository's own generator:
   `pnpm --filter ever-works-api migration:generate -- src/migrations/<name>` (see
   [quickstart.md](./quickstart.md) §7).
2. Find the newest migration actually on `develop` at merge time.
3. If `develop` has moved past this epic's block, **re-stamp the class name and the file name** to a
   timestamp above it, keeping the slot ordering inside the epic. Re-stamp again if `develop` moves between
   review and merge ([README](./README.md) §7 rule 6; [TRACKER.md](./TRACKER.md) "Migration timestamp
   blocks").
4. `down()` must drop **only** what `up()` created. A migration whose `down()` is not symmetric fails
   review — several epics state this explicitly ("`down()` drops only these two tables",
   "`down()` drops only them", "`down()` of each drops only what its `up()` created").
5. Forward-only: no migration edits a previously-shipped migration.

**Cross-epic ordering constraints worth knowing.** `work_builds` is referenced by APW-06's
`work_deployments.buildId` **without a FK**, deliberately, "to keep APW-05 merge order free";
`work_app_provisionings.deliveryBuildId`/`deliveryDeploymentId` (APW-08) are likewise FK-free; and
`work_upstream_states.conflictTaskId` is FK-free so a deleted Task cannot cascade. `work_app_runtime_states`
keeps its CASCADE because its row must outlive the teardown (R-15).

---

## 5. Portability — SQLite, Postgres, MySQL/MariaDB

The PR lane and the demo run **SQLite**; dev, stage and production run **Postgres**; the platform also
supports **MySQL/MariaDB**. Portability is therefore a correctness requirement, not a nicety.

| Concern                                           | Rule stated by the programme                                                                                                                                                                       | Source                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Timestamps compared in SQL (`nextSyncAt <= :now`) | use `TimestampColumn` (bigint epoch ms), as `WorkDeployment` does — not a driver date type                                                                                                         | [APW-02 §3.1](./APW-02-fork-lifecycle/plan.md) |
| Dates generally                                   | `PortableDateColumn`                                                                                                                                                                               | APW-03 §3.1 · APW-12 §3.6                      |
| Partial unique indexes                            | supported on Postgres **and** SQLite; APW-10's quarantine index needs a **unique expression index** on SQLite and the partial form on Postgres, branching on `queryRunner.connection.options.type` | APW-07 §3.4 · APW-10 §4                        |
| Unique index over a nullable column               | **avoid** — Postgres and SQLite both treat NULLs as distinct, so uniqueness does not hold; APW-11's `scopeKey` exists for exactly this reason                                                      | [APW-11 §3.2](./APW-11-app-launcher/plan.md)   |
| `work_builds` indexes                             | all six declared through TypeORM `TableIndex` — **no raw double-quoted SQL and no partial index** — so `up()`/`down()` behave identically on Postgres, SQLite, MySQL and MariaDB                   | [APW-05 §3.3](./APW-05-builds/plan.md)         |
| Race-safe single-row creation                     | `INSERT … ON CONFLICT (…) DO NOTHING` then read back (SQLite: `INSERT OR IGNORE`) — "first writer wins, losers re-read"                                                                            | APW-07 §3.1                                    |
| Atomic sequence allocation                        | `SELECT COALESCE(MAX(number),0)+1 … FOR UPDATE` on Postgres; SQLite takes the same path without the lock and retries up to 3 times on unique violation                                             | APW-05 §3.1                                    |
| Migration verification                            | a `DATABASE_AUTOMIGRATE` boot must be exercised on **both** a SQLite database and a Postgres service container, up and down                                                                        | [APW-12 `tasks.md`](./APW-12-ever-id/tasks.md) |

**Not stated anywhere:** an index-name convention for `work_app_runtime_states` and for the eight
`apps_tier_*` tables (only the column lists are given), and any FK/`ON DELETE` rule for the `apps_tier_*`
tables (deliberate — raw uuid references, EW-654 rule).

---

## 6. Entity registration — the four places the drift specs check

A new entity is not "added" until it is registered in **all four** places, or the database drift specs fail.
Every epic repeats the same list; APW-12 adds a fifth for its repository.

1. `packages/agent/src/entities/index.ts` — the export.
2. `packages/agent/src/database/_entity-names.ts` — the name in `AGENT_ENTITY_NAMES`.
3. `packages/agent/src/database/_entities-inventory.ts` — the import **and** the `ENTITIES` entry.
4. The owning module's `TypeOrmModule.forFeature([...])`.
5. _(APW-12 only)_ `packages/agent/src/database/_repository-inventory.ts` — the repository entry.

The drift specs that enforce it are `packages/agent/src/database/database.module.spec.ts` and
`database.config.spec.ts`. The most explicit statement of the list is
[`APW-05/plan.md`](./APW-05-builds/plan.md) §3.4 "Entity registration", which names both new entities
(`'WorkBuild'`, `'WorkBuildPreparation'`) and all four targets; the same four are listed in APW-02 §3.1,
APW-03 §3.1, APW-04 §3.1, APW-06 tasks, APW-07 §3.5, APW-09 §3.1, APW-10 §4, APW-11 §3.2 and APW-12 §3.1.

**Scope columns.** Tier A tables declare `tenantId`/`organizationId` without relation decorators so
`apps/api/src/scope/scope-stamping.subscriber.ts` stamps them. Two tables deliberately do **not**:
`app_launcher_preferences` (stamping `global` rows with the active Organization would be wrong) and
`external_identities` (Tier B: `tenantId` only, no `organizationId`).

---

## 7. Retention and the workspace backup (R-25)

Resolution **R-25** requires every table an App Works epic adds to be classified in the **same PR**: either a
file in a `BACKUP_DOMAIN_SPECS` domain, or an entry in `BACKUP_DROPPED_ENTITIES` with its reason. Each epic
also extends `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` so the classification
is enforced by a test. The owning tasks are APW-02 T45 · APW-03 T54 · APW-04 T47 · APW-05 T45 · APW-06 T65 ·
APW-07 T45 · APW-09 T35 · APW-10 T42 · APW-11 T30 · APW-12 T46.

| Domain / disposition                               | Tables                                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `works` domain, scoped through the parent Work ids | `work_upstream_states` · `work_app_spec_states` · `work_app_provisionings` · `work_builds` · `work_app_runtime_states` · `work_app_env_values` · `work_app_dependencies` · `upstream_pull_requests`             |
| account domain                                     | `app_launcher_preferences`                                                                                                                                                                                      |
| `runs` domain (record-only, time trim)             | `apps_tier_usage_windows`                                                                                                                                                                                       |
| rides an existing export                           | `work_deployments` (deployments) · `tasks` · `goals` · `missions` · `organizations` · `works`                                                                                                                   |
| **dropped**, with a recorded reason                | the seven APW-10 operator tables · `external_identities` (with sessions and auth tokens)                                                                                                                        |
| redacted to `{ wasSet }` / dropped column          | `work_app_env_values.valueEncrypted` → `{ wasSet }`; `work_app_env_values.valueBytes` dropped; `work_app_dependencies.configEncrypted`/`outputsEncrypted` → `{ wasSet }`; `work_builds.buildInputsHash` dropped |
| **unclassified**                                   | `work_build_preparations` — see §9 item 1                                                                                                                                                                       |

**Every secret-bearing column is named.** README §7 rule 8 and Constitution VII: App env values, kubeconfigs,
registry and Git tokens are encrypted, never logged and never returned. The two credential-bearing tables are
`work_app_env_values` and `work_app_dependencies`; tier credential fingerprints are dropped.

---

## 8. Delta vs `CONTRACTS.md` §2 — the three missing schema changes

`CONTRACTS.md` §2 states that it lists every persisted name the epics share. **Three schema changes the
programme actually makes are not in it.** Each is real, each is grounded, and each belongs in §2 verbatim (the
exact markdown to paste is in the hand-off below and in this file's companion request). Nothing is removed
from §2 — these are three additions.

| #   | Missing from `CONTRACTS.md` §2                                                                                          | Owner  | Grounded at                                                                                                                                                                                                                                                                                                                                                            | What §2 should say                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `organizations.appProvisionCaps` + migration `1792040100000-AddOrganizationAppProvisionCaps`                            | APW-04 | [`APW-04/tasks.md`](./APW-04-app-provisioner/tasks.md) T41 — "**Create** `apps/api/src/migrations/1792040100000-AddOrganizationAppProvisionCaps.ts` **(new)** — adds the one nullable column."                                                                                                                                                                         | the column, its shape `{ tokenCap?, runnerMinuteCap? }`, that it is nullable, and the resolution order Organization → instance env → default |
| 2   | `session.externalIdentityId` / `session.externalSid` + migration `1792120100000-AddExternalIdentityToSessions`          | APW-12 | [`APW-12/plan.md`](./APW-12-ever-id/plan.md) §3.2 and its §3.6 migration table row `1792120100000-AddExternalIdentityToSessions.ts` → "add `externalIdentityId`, `externalSid` + 2 indexes to `session`"                                                                                                                                                               | the two nullable columns, the two indexes, and that there is **no FK** on purpose                                                            |
| 3   | `work_builds.scanSummary` / `signatureState` / `blockedEgressHosts` + migration `1792050100000-AddWorkBuildSupplyChain` | APW-05 | [`APW-05/plan.md`](./APW-05-builds/plan.md) §3.3 second bullet — "**P3** `apps/api/src/migrations/1792050100000-AddWorkBuildSupplyChain.ts` — adds `scanSummary simple-json NULL` (`{ critical, high, medium, low, fixableCritical }`), `signatureState varchar(16) NULL` (`signed\|unsigned\|foreign`), `blockedEgressHosts simple-json NULL` (≤ 10). Additive only." | the three nullable columns and the fact that they are **P3** (Wave 3), so §2's `WorkBuild` row does not read as the final shape              |

> **Stale citations in the gap register, reported rather than copied.** The `SK-11` row cites
> `tasks.md:524` for the APW-04 migration (it is now `APW-04/tasks.md` T41 — the file grew during the
> programme's own editing), `plan.md:450` for the APW-05 supply-chain migration (now §3.3), and
> `plan.md:310` for APW-12 (still correct). The three facts are nevertheless real and were re-read at
> source; only the line numbers moved.

**Two further §2 gaps found while building this document** (not in the gap register, reported for the lead):

4. **`work_build_preparations`** is a whole table missing from §2's inventory. It is owned by APW-05 and
   created by the same `1792050000000-CreateWorkBuilds.ts` migration; the APW-05 gap note
   `APW05-G03` added it on 2026-09-17 ([`APW-05/plan.md`](./APW-05-builds/plan.md) §3.1b).
5. **`CONTRACTS.md` §2's APW-06 `WorkDeployment` row lists four columns, not five** — it names `buildId`,
   `componentStatuses`, `smokeResult` in the "**extended**" row and `appTarget`, `appRender` in the
   "**extended (added by APW-06)**" row, which together read as five, but the second row also repeats the
   states. It is correct in sum; it is noted here so the lead can confirm rather than assume. Also, §2
   mentions the migration block only as a one-line pointer ("Migration blocks: README §7 rule 6") rather than
   listing the 19 files — §4 of this document supplies that list if the lead wants it folded in.

---

## 9. Open items (honest list)

1. **`work_build_preparations` has no R-25 classification.** Neither [`APW-05/plan.md`](./APW-05-builds/plan.md)
   §3 or §3.3 nor its T45 names the table, and `ACCEPTANCE.md`'s ACC-REG-15 per-table assertion list omits it
   too. R-25's own wording ("every table an App Works epic adds") therefore has a hole. The safe reading is
   the `works` domain, giving it `data/works/build-preparations.jsonl`, but **that is a decision for APW-05
   and the lead — not something to invent here.**
2. **No index names for `work_app_runtime_states`** and **no index names or FK rules for the eight
   `apps_tier_*` tables.** The latter is deliberate (raw uuid references, EW-654 rule); the former looks like
   an omission in APW-06 §7.2 rather than a decision.
3. **No raw `CREATE TABLE` DDL exists anywhere** except two partial prose forms (APW-03 §3.3 and APW-11 §3.4).
   Every other table is specified as a markdown column table or a fenced column tree, and the migration is
   generated from the TypeORM entity. This is the house style and is fine — it does mean the entity file, not
   this document, is the last word on a column's exact driver type.
4. **`work_app_provisionings` gained `lastRunOutput`, `questionReason` and `questionParams`** during the
   programme's own editing pass. `CONTRACTS.md` §2's row describes the entity's purpose, not its columns, so
   the row is not wrong — but anyone reading §2 alone will not know the table holds a 512 KiB text column.
