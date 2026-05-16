import { test, expect } from '@playwright/test';

/**
 * EW-628 data-repo instant-sync — Playwright e2e scaffolding.
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md`
 * Acceptance: `docs/specs/features/data-repo-instant-sync/acceptance.md`
 *
 * The orchestration end-to-end (controller → service → dispatcher →
 * activity-feed emit) is fully covered IN-PROCESS by the API-side
 * integration spec at:
 *
 *   `apps/api/src/data-sync/data-sync.e2e.spec.ts`
 *
 * That spec drives the **real** `DataSyncService.runDataSync` three-gate
 * body, the **real** `DataSyncDispatcherService.dispatchDue` Path A /
 * Path B fan-out, and the **real** `DataSyncController.forceSync` shape
 * against an in-memory Work repository, in-memory cache, and stubbed
 * `MarkdownGeneratorService.syncFromDataRepo`. It covers AC-1, AC-2,
 * AC-3, AC-7, AC-10 with 8 deterministic assertions and runs in under
 * 13 seconds — no real GitHub App, no real git server, no Redis lock.
 *
 * The browser-level happy paths below (AC-1 through AC-7 driven against
 * a real running stack) still need fixtures that don't exist yet:
 *
 *   - a mock GitHub App that signs webhook deliveries against the
 *     production secret (so the signature check in
 *     `GithubAppWebhookController` passes),
 *   - a fake markdown-generator pipeline that can be toggled
 *     IDLE → RUNNING → COMPLETED at test-time,
 *   - a seeded Work whose `githubAppInstalled` flag flips per scenario,
 *   - a Redis-backed `DistributedTaskLockService` so the cross-process
 *     mutex paths exercise the real backend (not the in-process Map
 *     the integration spec uses).
 *
 * Until those fixtures land, the scenarios stay marked `test.fixme()`
 * so the file is discoverable in CI and the acceptance criteria stay
 * linked from the test runner. The skipped names match the AC ids
 * verbatim — `--grep AC-1` etc. wires up cleanly once the fixtures
 * exist. The non-fixture-dependent UI surface (Phase 7 — Sync chip +
 * SyncEventRow) is covered by the unit tests at
 * `apps/web/src/components/works/detail/activity/__tests__/`.
 */

test.describe('EW-628 data-sync — webhook path (AC-1)', () => {
    test.fixme('AC-1: webhook delivery within debounce window produces one .success row', async () => {
        // Browser-level coverage. Logic-level coverage already lives at
        // apps/api/src/data-sync/data-sync.e2e.spec.ts — see
        // "AC-1 — webhook flush dispatched via the cron".
        //
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
        // Logic-level coverage at apps/api/src/data-sync/data-sync.e2e.spec.ts
        // "AC-2 — poller flush dispatched via the cron".
        //
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
        // Logic-level coverage at apps/api/src/data-sync/data-sync.e2e.spec.ts
        // "AC-3 — mutex with the generation pipeline" (two scenarios).
        //
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
        // Logic-level coverage at apps/api/src/data-sync/data-sync.e2e.spec.ts
        // "AC-7 — data repo unreachable".
        //
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
