import { test, expect } from '@playwright/test';

/**
 * EW-628 data-repo instant-sync — e2e scaffolding.
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md`
 * Acceptance: `docs/specs/features/data-repo-instant-sync/acceptance.md`
 *
 * The full happy-path / failure-mode coverage requires:
 *   - a mock GitHub App (signed webhook deliveries + repo-content stubs),
 *   - a fake markdown-generator pipeline so we can flip its lifecycle from
 *     IDLE → RUNNING → COMPLETED inside the test,
 *   - a seeded Work with `githubAppInstalled` toggling per scenario, and
 *   - a Redis-backed DistributedTaskLockService so the mutex paths can be
 *     exercised against the real backend.
 *
 * Until that fixture lands, the scenarios below are marked `test.fixme()` so
 * the file is discoverable in CI and the acceptance criteria stay linked
 * from the test runner. The skipped names match the AC ids verbatim so
 * `--grep AC-1` etc. wires up cleanly once fixtures exist.
 *
 * The non-fixture-dependent UI surface (Phase 7 — Sync chip + SyncEventRow)
 * is covered by the unit tests in
 * `apps/web/src/components/works/detail/activity/__tests__/*.test.tsx`.
 *
 * TODO(EW-628 follow-up): replace the fixme blocks with real fixtures and
 *   drive the assertions directly against the seeded API.
 */

test.describe('EW-628 data-sync — webhook path (AC-1)', () => {
    test.fixme('AC-1: webhook delivery within debounce window produces one .success row', async () => {
        // 1. Install mock GitHub App on Work A (githubAppInstalled = true).
        // 2. POST 5 mock push deliveries within 10s to /webhooks/github-app.
        // 3. Wait 35s (debounce + a little) and assert exactly one
        //    `data-sync.success { source: "webhook" }` row with
        //    afterSha === HEAD of the last delivery, filesChanged >= 1.
        expect(true).toBe(true);
    });
});

test.describe('EW-628 data-sync — poller path (AC-2)', () => {
    test.fixme('AC-2: poll-driven sync runs within syncIntervalMinutes when App not installed', async () => {
        // 1. Seed Work B with githubAppInstalled = false, syncIntervalMinutes = 1.
        // 2. Make a commit to the mock data repo.
        // 3. Wait up to 70s for the dispatcher tick to fire syncFromDataRepo.
        // 4. Assert a `data-sync.success { source: "poll" }` row was emitted.
        // 5. Idle for another tick and assert the
        //    `data-sync.skipped { reason: "no-changes" }` row is rate-limited
        //    to ≤ 1 emission per skipNoiseWindowMs.
        expect(true).toBe(true);
    });
});

test.describe('EW-628 data-sync — mutex with generation (AC-3)', () => {
    test.fixme('AC-3: concurrent sync attempt during a RUNNING pipeline emits skipped:generation-in-progress', async () => {
        // 1. Seed Work C with an in-progress pipeline run (status RUNNING).
        // 2. Trigger a sync (webhook or force-sync — both paths share the gate).
        // 3. Assert exactly one
        //    `data-sync.skipped { reason: "generation-in-progress" }` row and
        //    NO call to MarkdownGeneratorService.syncFromDataRepo.
        // 4. Complete the pipeline; trigger another sync; assert it succeeds.
        expect(true).toBe(true);
    });
});

test.describe('EW-628 data-sync — data repo unreachable (AC-7)', () => {
    test.fixme('AC-7: GitHub 404 surfaces as failed:data-repo-unreachable and releases the lock', async () => {
        // 1. Point Work D at a non-existent data repo (or have the mock
        //    return 404 for one tick).
        // 2. Trigger a sync; assert a
        //    `data-sync.failed { errorClass: "data-repo-unreachable" }` row
        //    with errorTail ending in the last 200 chars of stderr.
        // 3. Assert lastSyncedDataRepoSha is unchanged.
        // 4. Trigger a second sync against a healthy repo; assert it
        //    runs (i.e. the previous lock was released).
        expect(true).toBe(true);
    });
});
