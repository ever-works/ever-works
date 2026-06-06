import { test, expect, type APIRequestContext } from '@playwright/test';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
} from './helpers/api';
import { seedKbSkippedUpload } from './helpers/kb-fixtures';

/**
 * EW-643 Phase 3 slice 5 — A38/A39/A40/A41 acceptance e2e for the
 * KB daily-reconciliation sweep
 * (`KnowledgeBaseReconcileService.reconcile()`,
 * `kb-reconcile.task.ts`).
 *
 *   A38 — Orphan storage objects (keys under `kb-originals/` that no
 *         live upload row references) surface in the reconciliation
 *         report counter.
 *   A39 — Stale upload rows (extractionStatus='running' older than
 *         `KB_RECONCILE_STALE_AFTER_MS`) are flipped to FAILED with
 *         `extractionError='reconcile: stale extraction'`.
 *   A40 — A `kb_reconcile_completed` activity-log entry is written
 *         after the sweep completes.
 *   A41 — The `kb.reconcile.completed` PostHog event is emitted with
 *         hit-count counters.
 *
 * Why this whole spec is gated:
 *
 *   The reconcile service is wired ONLY through the Trigger.dev cron
 *   (`packages/tasks/src/tasks/trigger/kb-reconcile.task.ts`, cron
 *   `42 3 * * *`). There is no REST endpoint that invokes it
 *   on-demand — searched via Grep in the slice 5 audit, confirmed
 *   absent. Driving the sweep from a Playwright spec therefore needs
 *   one of:
 *
 *     - A live Trigger.dev dev-server attached to the API (the
 *       `dev:trigger` script) AND the kb-reconcile task scheduled
 *       on-demand via the SDK; OR
 *     - A test-only HTTP entry point that calls
 *       `KnowledgeBaseReconcileService.reconcile()` directly; OR
 *     - A real S3-compatible storage backend with a `listObjects`
 *       implementation (the in-memory CI backend skips the orphan
 *       scan).
 *
 *   None of those are present in the CI sqlite env, so every scenario
 *   here is `test.skip` behind `KB_E2E_LIVE=1`. The spec still
 *   compiles (the helpers + selectors are real) and lays the
 *   foundation for the live-env reviewer to flip the flag and exercise
 *   the contract end to end.
 *
 *   A41 is additionally annotated `@needs-posthog` — even with the
 *   live infra wired, asserting the PostHog event requires the
 *   project's e2e PostHog probe helper. The skill prompt for this
 *   slice says: "assert via the e2e PostHog probe helper if one
 *   exists, otherwise mark @needs-posthog". Probed the helpers
 *   directory; no such helper exists today (the codebase has runtime
 *   integration in `packages/monitoring/` but no e2e probe). The
 *   annotation flags A41 for the follow-up that adds the probe.
 */

const KB_E2E_LIVE = process.env.KB_E2E_LIVE === '1';

interface UploadRow {
    id: string;
    extractionStatus: string;
    extractionError: string | null;
    storagePath: string | null;
}

interface ActivityRow {
    actionType: string;
    workId: string | null;
    createdAt: string;
    details?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
}

interface ActivityListResponse {
    activities: ActivityRow[];
    total: number;
}

interface ReconcileSummary {
    orphanedObjects: number;
    staleUploads: number;
    durationMs?: number;
}

function runId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Drive the reconcile sweep. Live envs MAY expose a test-only POST
 * `/api/works/:id/kb/_test/reconcile`; if it returns 404 we surface
 * the gap so the live runner knows to wire it.
 *
 * Returns null when the env has no driver available (the caller then
 * skips the strict assertions but the upload state can still be
 * inspected against the DB-side service behaviour).
 */
async function triggerReconcileForWork(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<ReconcileSummary | null> {
    const res = await request.post(
        `${API_BASE}/api/works/${workId}/kb/_test/reconcile`,
        { headers: authedHeaders(token) },
    );
    if (res.status() === 404 || res.status() === 405) return null;
    if (!res.ok()) {
        throw new Error(`reconcile driver failed (${res.status()}): ${await res.text()}`);
    }
    return (await res.json()) as ReconcileSummary;
}

test.describe('flow: KB daily reconciliation acceptance (A38/A39/A40/A41)', () => {
    test.beforeAll(() => {
        // Single gate for the whole describe block — every scenario needs
        // the live infra (Trigger.dev attach OR test-only reconcile route
        // OR S3 backend with listObjects). CI sqlite skips entirely.
        test.skip(
            !KB_E2E_LIVE,
            'KB reconciliation requires KB_E2E_LIVE=1 (Trigger.dev + listObjects-capable storage + on-demand reconcile driver). The reconcile sweep has no REST endpoint and the CI in-memory storage skips the orphan scan.',
        );
    });

    test('A38 — orphan storage object surfaces in the reconciliation report', async ({
        request,
    }) => {
        test.setTimeout(180_000);
        const id = runId();
        const owner = await registerUserViaAPI(request, { name: `Rec A38 ${id}` });
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `KB A38 ${id}`,
        });

        // Seed an upload so a known storage key exists, then ask the
        // live env to inject an orphan key under `kb-originals/`. The
        // injection contract is part of the KB_E2E_LIVE harness — same
        // gate as the driver below.
        await seedKbSkippedUpload(request, owner.access_token, workId, {
            filename: `a38-baseline-${id}.bin`,
            body: Buffer.from(`A38 baseline ${id}`, 'utf8'),
        });

        // The live harness exposes a sibling endpoint to fabricate an
        // orphan; if it isn't wired yet the spec records that gap.
        const inject = await request.post(
            `${API_BASE}/api/works/${workId}/kb/_test/orphan-object`,
            {
                headers: authedHeaders(owner.access_token),
                data: { key: `kb-originals/orphan-${id}.bin` },
            },
        );
        if (inject.status() === 404 || inject.status() === 405) {
            test.info().annotations.push({
                type: 'kb-e2e-live-gap',
                description:
                    'KB_E2E_LIVE harness is missing POST /works/:id/kb/_test/orphan-object — wire it to fabricate orphan storage keys for A38.',
            });
            test.skip(true, 'no orphan-injection driver in this env');
            return;
        }
        expect(inject.ok(), 'orphan injection succeeds').toBeTruthy();

        const summary = await triggerReconcileForWork(request, owner.access_token, workId);
        test.skip(!summary, 'no on-demand reconcile driver in this env');
        expect(summary!.orphanedObjects, 'orphan storage object counted').toBeGreaterThanOrEqual(1);
    });

    test('A39 — stale running upload row is flipped to FAILED after staleAfter', async ({
        request,
    }) => {
        test.setTimeout(180_000);
        const id = runId();
        const owner = await registerUserViaAPI(request, { name: `Rec A39 ${id}` });
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `KB A39 ${id}`,
        });

        // Seed an upload then ask the live harness to age it past
        // `KB_RECONCILE_STALE_AFTER_MS` (the harness sets
        // extractionStatus='running' + extractionStartedAt back in time).
        const { uploadId } = await seedKbSkippedUpload(request, owner.access_token, workId, {
            filename: `a39-${id}.bin`,
            body: Buffer.from(`A39 ${id}`, 'utf8'),
        });

        const age = await request.post(
            `${API_BASE}/api/works/${workId}/kb/_test/uploads/${uploadId}/age`,
            {
                headers: authedHeaders(owner.access_token),
                data: { staleByMs: 48 * 3600_000 },
            },
        );
        if (age.status() === 404 || age.status() === 405) {
            test.info().annotations.push({
                type: 'kb-e2e-live-gap',
                description:
                    'KB_E2E_LIVE harness is missing POST /works/:id/kb/_test/uploads/:uploadId/age — wire it to backdate extractionStartedAt for A39.',
            });
            test.skip(true, 'no upload-aging driver in this env');
            return;
        }
        expect(age.ok(), 'aging driver succeeds').toBeTruthy();

        const summary = await triggerReconcileForWork(request, owner.access_token, workId);
        test.skip(!summary, 'no on-demand reconcile driver in this env');
        expect(summary!.staleUploads, 'stale upload flipped').toBeGreaterThanOrEqual(1);

        const after = await request.get(
            `${API_BASE}/api/works/${workId}/kb/uploads/${uploadId}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(after.ok()).toBeTruthy();
        const row = (await after.json()) as UploadRow;
        expect(row.extractionStatus).toBe('failed');
        expect(row.extractionError).toContain('reconcile: stale extraction');
    });

    test('A40 — activity-log entry recorded after reconcile completes', async ({ request }) => {
        test.setTimeout(180_000);
        const id = runId();
        const owner = await registerUserViaAPI(request, { name: `Rec A40 ${id}` });
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `KB A40 ${id}`,
        });

        const summary = await triggerReconcileForWork(request, owner.access_token, workId);
        test.skip(!summary, 'no on-demand reconcile driver in this env');

        // Activity-log writer for KB_RECONCILE_COMPLETED lives in the
        // KB_RECONCILE_COMPLETED branch of `ActivityLogService`. Poll
        // the log for a row scoped to this Work.
        const deadline = Date.now() + 30_000;
        let matched: ActivityRow | null = null;
        while (Date.now() < deadline) {
            const res = await request.get(
                `${API_BASE}/api/activity-log?workId=${encodeURIComponent(workId)}&actionType=kb_reconcile_completed&limit=10`,
                { headers: authedHeaders(owner.access_token) },
            );
            if (res.ok()) {
                const body = (await res.json()) as ActivityListResponse;
                if (body.activities.length > 0) {
                    matched = body.activities[0];
                    break;
                }
            }
            await new Promise((r) => setTimeout(r, 1_000));
        }
        expect(matched, 'kb_reconcile_completed activity row written').not.toBeNull();
    });

    test('A41 — PostHog kb.reconcile.completed event emitted @needs-posthog', async ({
        request,
    }) => {
        test.setTimeout(180_000);
        const id = runId();
        const owner = await registerUserViaAPI(request, { name: `Rec A41 ${id}` });
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `KB A41 ${id}`,
        });

        const summary = await triggerReconcileForWork(request, owner.access_token, workId);
        test.skip(!summary, 'no on-demand reconcile driver in this env');

        // Probed the e2e helpers (`apps/web/e2e/helpers/`) on 2026-06-06:
        // there is no PostHog probe helper today. The KB reconcile
        // service calls `posthog.capture({ event: 'kb.reconcile.completed', ...})`
        // via the optional `KB_RECONCILE_POSTHOG_CLIENT` token, so a
        // future probe helper can capture the emitted events in-process
        // and assert against them.
        //
        // For now: annotate the gap and assert the visible side effect
        // — the summary returned by the reconcile driver carries the
        // same counters the PostHog payload ships (orphanedObjects /
        // staleUploads). The strict event-emission check waits for the
        // probe helper to land.
        test.info().annotations.push({
            type: 'needs-posthog',
            description:
                'A41 PostHog assertion needs an e2e PostHog probe helper (not present in apps/web/e2e/helpers/ as of 2026-06-06). Until it lands, the spec asserts the visible reconcile-summary counters that the PostHog payload mirrors; replace with a strict event-emission check once the probe is wired.',
        });

        expect(summary!.orphanedObjects, 'orphanedObjects is numeric').toBeGreaterThanOrEqual(0);
        expect(summary!.staleUploads, 'staleUploads is numeric').toBeGreaterThanOrEqual(0);
    });
});
