# Acceptance Criteria: Instant Data-Repo → Main-Repo Sync

**Feature ID**: `data-repo-instant-sync`
**Spec**: [`./spec.md`](./spec.md)
**Status**: `Draft`
**Last updated**: 2026-05-16

---

## Core behaviour

### AC-1: Webhook-driven sync (App installed)

- [ ] Editing `categories.yml` on the data repo and committing to default branch triggers a sync within **30 seconds** (debounce window).
- [ ] The main repo's `README.md` reflects the new category after the sync completes.
- [ ] An activity row of type `data-sync.success` appears with `source: webhook`, correct `beforeSha` / `afterSha`, and `filesChanged >= 1`.
- [ ] Five commits to the data repo within 10 seconds coalesce into a single sync run (one `.success` row, `afterSha = HEAD of last commit`).

### AC-2: Poller-driven sync (App not installed)

- [ ] On a Work with `githubAppInstalled = false` and `syncIntervalMinutes = 5`, editing a markdown file in the data repo via a manual `git push` results in a sync within **≤ 5 minutes**.
- [ ] Activity row `data-sync.success` records `source: poll`.
- [ ] If no commits are made for 24h, only 24 `data-sync.skipped reason=no-changes` rows appear (rate-limited to 1 per hour), not 288.

### AC-3: Mutex with generation pipeline

- [ ] When a generation pipeline run is `RUNNING`, a concurrent sync attempt emits `data-sync.skipped reason=generation-in-progress` and does NOT call `MarkdownGeneratorService.syncFromDataRepo()`.
- [ ] After the generation pipeline completes, the next webhook delivery (Path A) or next poll tick (Path B) detects the SHA delta and successfully runs the deferred sync.
- [ ] When two sync runs are triggered within the same second, only one acquires the lock; the other emits `.skipped reason=sync-in-progress`.

### AC-4: Lock TTL recovery

- [ ] If `dataRepoSyncTask` crashes with the lock held (simulated via `kill -9`), a new sync attempt 5 minutes later acquires the lock cleanly (no stuck Work).
- [ ] The dispatcher (`WorkScheduleDispatcherService.dispatchDue`) skips the locked Work and resumes scheduling for it once the lock expires.

## Render correctness

### AC-5: Render parity with full pipeline

- [ ] For a Work with no item changes (only category/tag changes), the resulting `README.md` produced by `syncFromDataRepo()` is **byte-identical** to the README produced by a full `WorkScheduleDispatcherTask` run.
- [ ] `details/<slug>.md` files are written exactly as they would be by the full pipeline.
- [ ] No `items/` regeneration occurs — verified by absence of AI provider calls in test logs.

### AC-6: Idempotency

- [ ] Running `syncFromDataRepo` twice in a row against the same data-repo SHA produces `filesChanged: 0` on the second run.
- [ ] The second run still emits an activity row (`.success` with `filesChanged: 0`) so users can see the sync attempt happened.

## Failure modes

### AC-7: Data repo unreachable

- [ ] If the data repo returns 404 / 403 from GitHub, the sync emits `data-sync.failed` with `errorClass: 'data-repo-unreachable'` and `errorTail` containing the last 200 chars of stderr.
- [ ] The lock is released; subsequent runs are not blocked.
- [ ] The Work's `lastSyncedDataRepoSha` is **not** updated.

### AC-8: Main repo push rejected

- [ ] If the main repo push is rejected (branch protection / force-push refused / merge conflict from a parallel manual edit), the sync emits `data-sync.failed` with `errorClass: 'main-repo-push-rejected'`.
- [ ] On the next tick the sync retries; if the underlying conflict resolves naturally, the retry succeeds and emits `.success`.

### AC-9: Webhook signature invalid

- [ ] A `push` payload with an invalid `x-hub-signature-256` returns 401 from the webhook controller, does not emit any activity row, and does not touch the lock or queue.

## Force-sync endpoint

### AC-10: POST /api/works/:id/sync

- [ ] Returns 202 with `{ activityRowId, status: 'enqueued' }` for a healthy Work.
- [ ] Returns 202 with `{ status: 'skipped', reason: 'generation-in-progress' }` when the pipeline is RUNNING (no error, by design).
- [ ] Returns 403 for an unauthenticated caller; 404 for an unknown Work id.
- [ ] Auth check rejects users without write access to the Work.

## Activity feed UI

### AC-11: Sync chip + rows

- [ ] The `Sync` filter chip appears on the activity page next to `Generate`.
- [ ] Clicking the chip filters to only `data-sync.*` rows.
- [ ] `data-sync.success` rows show short SHAs (7-char prefix), files-changed count, and a clock duration.
- [ ] `data-sync.failed` rows render with an alert variant and an expandable disclosure showing `errorTail`.
- [ ] `data-sync.skipped` rows render with a muted variant and the reason verbatim.

## Telemetry

### AC-12: Counters and histogram

- [ ] On a successful webhook-triggered sync, `data_sync_success_total{source="webhook"}` increments by 1 and `data_sync_duration_ms` records a sample.
- [ ] A skipped sync increments `data_sync_skipped_total{reason,source}` with the correct labels.
- [ ] A failed sync increments `data_sync_failed_total{errorClass,source}`.
- [ ] PostHog dashboard `Data Sync` shows per-day totals, p50/p95 duration, and top error classes.

## Feature-flag gating

### AC-13: Both flags off (default at first deploy)

- [ ] With `subscriptions.dataSync.webhookEnabled = false`: `push` events are accepted (200 OK) but do not enqueue. No activity rows.
- [ ] With `subscriptions.dataSync.pollerEnabled = false`: the poller task either does not run or short-circuits and emits no rows.
- [ ] Toggling either flag to `true` enables the corresponding path without a redeploy (env var read on each task run).

## Rollout / regression

### AC-14: No regression to the scheduled pipeline

- [ ] The existing scheduled generation pipeline (`WorkScheduleDispatcherTask`) continues to run end-to-end on its existing per-Work cadence.
- [ ] Items, comparisons, taxonomy, and markdown rendering are byte-identical to the pre-feature output on a control Work that does not receive any data-repo edits during the test window.

### AC-15: Migration safety

- [ ] Migration up + down + up cycle on a snapshot of staging data completes in < 60 seconds with no row-level errors.
- [ ] Backfill of `github_app_installed = true` covers every Work that has a non-null `github_app_installation_id` and only those Works.

### AC-16: Telemetry sampling sanity

- [ ] Over a 24-hour soak on `develop` with 50+ active Works, total counter values are within ±2% of the activity-row counts (no drops, no double-counts).
