# Task Breakdown: Instant Data-Repo → Main-Repo Sync

**Feature ID**: `data-repo-instant-sync`
**Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft` (revised 2026-05-16 — no Redis; one dispatcher task instead of two)
**Last updated**: 2026-05-16

---

## Phase 1 — Schema and entity (1 PR commit)

- [ ] **T1**. Migration `<ts>-data-repo-instant-sync.ts` adds `last_synced_data_repo_sha`, `pending_sync_requested_at`, `sync_interval_minutes` (default 5), `github_app_installed` (default false), `last_polled_at` columns.
- [ ] **T2**. Create two partial indexes: `idx_work_sync_poller` and `idx_work_sync_webhook` (see `plan.md §7`).
- [ ] **T3**. `Work` entity fields mirror the columns. JSDoc each.
- [ ] **T4**. Backfill: in the migration `up()`, set `github_app_installed = true` for Works whose `github_app_installation_id` is non-null (single SQL UPDATE).
- [ ] **T5**. `down()` drops indexes and columns cleanly. Verify with a local migrate:down → migrate:up cycle.

## Phase 2 — Render-only entry on `MarkdownGeneratorService` (1 PR commit)

- [ ] **T6**. Extract the body of `MarkdownGeneratorService.initialize()` from the data-clone step through the push step into a private `renderToMainRepo(ctx)` helper. No behaviour change for the existing pipeline path.
- [ ] **T7**. Add public `syncFromDataRepo({ workId, expectedSourceSha?, abortSignal? })` that builds the ctx without invoking `ItemsGeneratorService` and calls `renderToMainRepo`.
- [ ] **T8**. Unit tests in `markdown-generator.service.spec.ts`: happy path; HEAD differs from `expectedSourceSha` (proceeds with note); abort propagation; idempotent re-run on the same SHA returns `filesChanged: 0`; empty data repo handled.
- [ ] **T9**. Verify the existing `packages/agent` Jest suites remain green (no regressions from the extraction).

## Phase 3 — DataSyncService (1 PR commit)

- [ ] **T10**. `apps/api/src/data-sync/data-sync.module.ts`, `data-sync.service.ts`, `data-sync.types.ts`.
- [ ] **T11**. Import `CacheEntry` via `TypeOrmModule.forFeature` and provide `DistributedTaskLockService` per the canonical pattern in [`distributed-task-lock.md`](../../../agent-services/distributed-task-lock.md#module-wiring).
- [ ] **T12**. `runDataSync(workId, source)` per the pseudo-code in `plan.md §6`. Gates run in order inside the lock:
    1. **Retry-backoff gate** — check `data-sync:retry-after:<workId>` cache entry; if present, emit `data-sync.skipped reason=retry-backoff` and return.
    2. **Pipeline-RUNNING gate** — if `Work.pipelineStatus === 'RUNNING'`: write `data-sync.skipped reason=generation-in-progress` only if the `data-sync:gen-in-progress-noise:<workId>` entry is absent, then write that entry with TTL `genInProgressNoiseWindowMs / 1000`. Return.
    3. **Render** — call `MarkdownGeneratorService.syncFromDataRepo`. Success: clear `pendingSyncRequestedAt`, update `lastSyncedDataRepoSha`, `cache.del('data-sync:gen-in-progress-noise:<workId>')`. Failure: write `data-sync:retry-after:<workId>` with TTL `retryBackoffSeconds` (paired with Gate 1).
- [ ] **T13**. Unit tests covering all six branches:
    - success → success row + `pendingSyncRequestedAt` cleared + gen-in-progress noise entry cleared.
    - generation-in-progress (first call within noise window) → one skip row emitted + noise entry written.
    - generation-in-progress (repeat call within noise window) → silent (no skip row written) but still returns the right outcome.
    - retry-backoff → backoff key present → one skip row, never reaches pipeline check.
    - sync-in-progress → `onLocked` callback fires; assertion must verify the skip activity row is actually persisted (not just that the function returns the `'sync-in-progress'` status), since a swallowed `activity.record()` write would otherwise leave the operator without a trace.
    - failed → `data-sync.failed` row + retry-backoff key written + `pendingSyncRequestedAt` left intact.
- [ ] **T14**. Add a public `isLocked(workId)` helper on `DataSyncService` that wraps a `cache_entries` peek. Amend `WorkScheduleDispatcherService.dispatchDue()` to skip locked Works.

## Phase 4 — Trigger.dev dispatcher (1 PR commit)

- [ ] **T15**. `packages/tasks/src/tasks/trigger/data-repo-sync-dispatcher.task.ts`:
    - `schedules.task` with `*/1 * * * *`.
    - Bulk SELECT eligible Works (UNION ALL of webhook-flush + polling-due rows, per `spec.md §5.3`).
    - For each row: Path A → call `DataSyncService.runDataSync(workId, 'webhook')`. Path B → `ls-remote HEAD`; if delta, `runDataSync(workId, 'poll')`; else emit rate-limited `no-changes` skip.
    - Always update `lastPolledAt` for Path B Works regardless of delta.
    - Telemetry counters from `spec.md §8`.
- [ ] **T16**. `dataRepoSyncTask` (worker side) is a regular Trigger.dev `task` (not `schedules.task`) so the dispatcher can fan out via `tasks.trigger`. It simply forwards to `DataSyncService.runDataSync()`.
- [ ] **T17**. Vitest coverage for the dispatcher's eligibility SQL and the per-Work fan-out branch logic.

## Phase 5 — Webhook push handler (1 PR commit)

- [ ] **T18**. Subscribe the GitHub App to `push` events (update App manifest + webhook permissions doc note).
- [ ] **T19**. `github-app-webhook.controller.ts` adds a `push` branch routing to `GithubAppSyncService.handlePushEvent(payload)`.
- [ ] **T20**. `handlePushEvent`:
    - Resolve `repository.full_name` → Work via `Work.dataRepo.fullName`. Unknown → 200 OK, log debug.
    - `UPDATE work SET pending_sync_requested_at = now() WHERE id = :id` (idempotent; multiple commits collapse).
- [ ] **T21**. Unit tests: known repo → column updated; unknown repo → no-op; signature failure handled by existing controller logic (no change needed).
- [ ] **T22**. Manual smoke against a sandbox Work — see `acceptance.md` AC-1.

## Phase 6 — Force-sync endpoint (1 PR commit)

- [ ] **T23**. `POST /api/works/:id/sync` controller in `data-sync.controller.ts`. Auth: same guard as `/api/works/:id/generate`.
- [ ] **T24**. Returns `202 Accepted` with `{ activityRowId, status: 'enqueued' | 'skipped', reason? }`.
- [ ] **T25**. Supertest integration test (happy path + generation-in-progress = 202 with skipped status).

## Phase 7 — Activity feed UI (1 PR commit)

- [ ] **T26**. Extend `apps/web/src/components/works/activity/activity-filter-chips.tsx` with a `Sync` chip.
- [ ] **T27**. New `sync-event-row.tsx` renders the three sync events with distinct icon (`git-pull-request`), before/after SHA short-hashes, and a "View error" disclosure for `.failed` rows.
- [ ] **T28**. i18n strings added to `apps/web/src/lib/i18n/en/works.json` (English only this PR; other locales follow).
- [ ] **T29**. Vitest snapshot covers all three event types.

## Phase 8 — Telemetry + flags (1 PR commit)

- [ ] **T30**. Counters `data_sync_success_total{source}`, `data_sync_skipped_total{reason,source}`, `data_sync_failed_total{errorClass,source}`, `data_sync_lock_contention_total`, and `data_sync_duration_ms` histogram registered with the existing `packages/monitoring`.
- [ ] **T31**. Two flags on `subscriptions` config: `dataSync.webhookEnabled` (default `false`) and `dataSync.dispatcherEnabled` (default `false`).
- [ ] **T32**. Webhook handler and dispatcher short-circuit when their flag is `false`. Tests cover the gated paths.
- [ ] **T33**. After 1 week of clean `main` data, remove the flags in a follow-up (out of this PR).

## Phase 9 — Acceptance verification (final commit of code PR)

- [ ] **T34**. Run the manual smoke matrix from `acceptance.md` against a develop env Work. Attach the activity-feed screenshots to the PR.
- [ ] **T35**. Update `docs/changelog.md` and `docs/features/data-management.md` with a short subsection pointing to this spec.

## Phase 10 — Cascade (not in code PR)

- [ ] **T36**. After develop → soak → cascade to `stage` PR, then `stage → main` PR.
- [ ] **T37**. After 1 week clean on `main`: delete the two flags and the gated short-circuit branches.
