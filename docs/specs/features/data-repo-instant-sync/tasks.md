# Task Breakdown: Instant Data-Repo → Main-Repo Sync

**Feature ID**: `data-repo-instant-sync`
**Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-05-16

---

## Phase 1 — Schema and entity (1 PR commit)

- [ ] **T1**. Migration `<ts>-data-repo-instant-sync.ts` adds `last_synced_data_repo_sha`, `sync_interval_minutes` (default 5), `github_app_installed` (default false), `last_polled_at` columns + composite poller index.
- [ ] **T2**. `Work` entity fields mirror the columns. JSDoc each.
- [ ] **T3**. Backfill: in the migration `up()`, set `github_app_installed = true` for Works whose `github_app_installation_id` is non-null (single SQL UPDATE).
- [ ] **T4**. `down()` drops everything cleanly. Verify with a local migrate:down → migrate:up cycle.

## Phase 2 — Render-only entry on MarkdownGeneratorService (1 PR commit)

- [ ] **T5**. Extract the body of `MarkdownGeneratorService.initialize()` from the data-clone step through the push step into a private `renderToMainRepo(ctx)` helper. No behaviour change for the existing pipeline path.
- [ ] **T6**. Add public `syncFromDataRepo({ workId, expectedSourceSha?, abortSignal? })` that builds the ctx without invoking ItemsGeneratorService and calls `renderToMainRepo`.
- [ ] **T7**. Unit tests in `markdown-generator.service.spec.ts`: happy path; HEAD differs from `expectedSourceSha` (proceeds with a note); abort propagation; idempotent re-run on the same SHA returns `filesChanged: 0`; empty data repo handled.
- [ ] **T8**. Verify the existing 26-suite `packages/agent` Jest run remains green (no regressions from the extraction).

## Phase 3 — DataSyncService + lock (1 PR commit)

- [ ] **T9**. `apps/api/src/data-sync/data-sync.module.ts`, `data-sync.service.ts`, `data-sync.types.ts`. Service exposes `tryAcquireSyncLock(workId)`, `releaseSyncLock(workId)`, `isSyncLocked(workId)`.
- [ ] **T10**. `tryAcquireSyncLock` uses `SET … NX EX 300` and the pipeline-status check from §plan.md.6.
- [ ] **T11**. Unit tests: contention (two parallel calls — one wins); generation-in-progress release; TTL recovery after simulated crash (Redis returns stale lock — second call still succeeds after TTL).
- [ ] **T12**. Amend `WorkScheduleDispatcherService.dispatchDue()` to skip Works with `isSyncLocked(workId) === true`. Test covers skip + later resume.

## Phase 4 — Trigger.dev tasks (1 PR commit)

- [ ] **T13**. `packages/tasks/src/tasks/trigger/data-repo-sync.task.ts`:
    - Input: `{ workId, sourceSha, source: 'webhook' | 'poll' | 'manual' }`.
    - Acquire sync lock → call `MarkdownGeneratorService.syncFromDataRepo` → release lock.
    - Record `data-sync.success` / `.skipped` / `.failed` via `ActivityLogService`.
    - Update `Work.lastSyncedDataRepoSha` on success.
    - Emit telemetry counters.
- [ ] **T14**. `packages/tasks/src/tasks/trigger/data-repo-poller.task.ts`:
    - `schedules.task` with `*/5 * * * *`.
    - Bulk-fetch eligible Works (`github_app_installed = false AND (last_polled_at IS NULL OR last_polled_at < now() - sync_interval_minutes * interval '1 minute')`).
    - For each: `ls-remote HEAD` → compare with `lastSyncedDataRepoSha` → enqueue `dataRepoSyncTask` if differ.
    - Update `last_polled_at` regardless.
    - Rate-limit `no-changes` skip rows (1 per Work per hour).
- [ ] **T15**. Vitest coverage per §plan.md.8.

## Phase 5 — Webhook push handler (1 PR commit)

- [ ] **T16**. Subscribe the GitHub App to `push` events (update App manifest + webhook permissions doc note).
- [ ] **T17**. `github-app-webhook.controller.ts` adds a `push` branch routing to `GithubAppSyncService.handlePushEvent(payload)`.
- [ ] **T18**. `handlePushEvent`:
    - Resolve `repository.full_name` → Work via `Work.dataRepo.fullName`. Unknown → return 200, log debug.
    - Schedule the debounced enqueue (Redis ZSET implementation in `data-sync.service.ts`).
- [ ] **T19**. Unit tests: known repo → debounce; unknown repo → no-op; identical pushes within 30s coalesce.
- [ ] **T20**. Manual smoke against a sandbox Work — see `acceptance.md` AC-1.

## Phase 6 — Force-sync endpoint (1 PR commit)

- [ ] **T21**. `POST /api/works/:id/sync` controller in `data-sync.controller.ts`. Auth: same guard as `/api/works/:id/generate`.
- [ ] **T22**. Returns `202 Accepted` with `{ activityRowId, status: 'enqueued' | 'skipped', reason? }`.
- [ ] **T23**. Supertest integration test (happy path + generation-in-progress = 202 with skipped status).

## Phase 7 — Activity feed UI (1 PR commit)

- [ ] **T24**. Extend `apps/web/src/components/works/activity/activity-filter-chips.tsx` with a `Sync` chip.
- [ ] **T25**. New `sync-event-row.tsx` renders the three sync events with distinct icon (`git-pull-request`), before/after SHA short-hashes, and a "View error" disclosure for `.failed` rows.
- [ ] **T26**. i18n strings added to `apps/web/src/lib/i18n/en/works.json` (no need to backfill 20 locales in this PR; copy can come later — chip falls back to English).
- [ ] **T27**. Vitest snapshot covers all three event types.

## Phase 8 — Telemetry + flags (1 PR commit)

- [ ] **T28**. Counters `data_sync_success_total{source}`, `data_sync_skipped_total{reason,source}`, `data_sync_failed_total{errorClass,source}`, and `data_sync_duration_ms` histogram registered with the existing monitoring package.
- [ ] **T29**. Two flags on `subscriptions` config: `dataSync.webhookEnabled` (default `false`) and `dataSync.pollerEnabled` (default `false`).
- [ ] **T30**. Webhook handler and poller short-circuit when their flag is `false`. Tests cover the gated paths.
- [ ] **T31**. After 1 week of clean `main` data, remove the flags in a follow-up (out of this PR).

## Phase 9 — Acceptance verification (final commit of code PR)

- [ ] **T32**. Run the manual smoke matrix from `acceptance.md` against a develop env Work. Attach the activity-feed screenshots to the PR.
- [ ] **T33**. Update `docs/changelog.md` and `docs/features/data-management.md` with a short subsection pointing to this spec.

## Phase 10 — Cascade (not in code PR)

- [ ] **T34**. After develop → soak → cascade to `stage` PR, then `stage → main` PR. Standard release flow per project rules.
- [ ] **T35**. After 1 week clean on `main`: delete the two flags and the gated short-circuit branches.
