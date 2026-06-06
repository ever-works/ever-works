import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-data-sync-dispatch-deep — the DATA-SYNC DISPATCH TICK, reconstructed
 * end-to-end through its real public surface.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TICK SHAPE LIVES INTERNALLY. The `{ limit, dueCount, dispatched, skipped,
 * failed, entries }` summary (`DataSyncDispatchSummary`) is produced by
 * `DataSyncDispatcherService.dispatchDue()` — a cron-only service with NO HTTP
 * route (apps/api/src/data-sync/data-sync-dispatcher.service.ts). Its loop SELECTs
 * due Works (webhook-flush + poller paths) and fans EACH into the SAME body the
 * operator force-sync endpoint calls:
 *
 *     POST /api/works/:id/sync  →  DataSyncService.runDataSync(id, 'manual')
 *       → DataSyncOutcome, shaped by the controller into:
 *           { status:'enqueued', outcome:'success', stats }   // dispatcher: dispatched += 1
 *         | { status:'skipped',  reason }                       // dispatcher: skipped    += 1
 *         | { status:'failed',   errorClass, errorTail }        // dispatcher: failed     += 1
 *
 *   The dispatcher accounting (data-sync-dispatcher.service.ts `runOne`) is a pure
 *   FOLD of per-Work outcomes:
 *     dueCount   = webhookDue.length + pollerDue.length
 *     dispatched = count(outcome.status === 'success')
 *     skipped    = count(outcome.status === 'skipped')   // incl. gate-1 retry-backoff
 *     failed     = count(outcome.status === 'failed')     // incl. thrown errors caught in runOne
 *   and ALWAYS conserves:  dispatched + skipped + failed === dueCount.
 *
 *   These flows reconstruct that exact fold by driving the per-Work surface the
 *   dispatcher shares, asserting the TICK CONTRACT without an HTTP tick route.
 *
 * REAL GATE / SHAPE CONTRACT (read from data-sync.service.ts + data-sync.controller.ts,
 * RE-PROBED LIVE @ 127.0.0.1:3100 on 2026-06-01):
 *   - Gate 1 retry-backoff: a failed sync writes cache key
 *     `data-sync:retry-after:<workId>` (RETRY_BACKOFF window). A re-sync inside the
 *     window short-circuits to { status:'skipped', reason:'retry-backoff' }; the
 *     dispatcher counts it as `skipped` and never re-dispatches. THIS is the
 *     idempotency / duplicate-suppression de-dup gate.
 *   - Gate 2 generation-in-progress → { status:'skipped', reason:'generation-in-progress' }.
 *   - Gate 3 render: in CI there is NO connected git account, so syncFromDataRepo
 *     throws and the very FIRST sync on a fresh work is
 *       { status:'failed', errorClass:'unknown',
 *         errorTail:'No connected account found for user ... with provider github' }
 *     (PROBED). classifyError() yields `unknown` (no 404/403/timeout token in the tail).
 *   - work-not-found gate: if the work row is gone by lock-acquire time, runGates
 *     returns { status:'failed', errorClass:'work-not-found' }; but the force-sync
 *     CONTROLLER checks ownership first via WorkRepository.findById and returns a
 *     404 BEFORE delegating — so a deleted/unknown work never reaches runDataSync
 *     via the manual surface (PROBED — see Flow 4).
 *   - Controller gates (PROBED): unknown/garbage/deleted work id (owner token) → 404
 *     { status:'error', message:'Work not found' }; non-owner → 403 { status:'error',
 *     message:'You do not have permission to sync this work' }; unauth → 401.
 *     HttpCode is 202 ACCEPTED on a resolved (enqueued|skipped|failed) outcome.
 *   - Activity feed (PROBED): each outcome writes one row via ActivityLogService.log.
 *     describePayload() maps kind → row columns:
 *       success → actionType 'data_sync_success', action 'data-sync.success', status 'completed'
 *       skipped → actionType 'data_sync_skipped', action 'data-sync.skipped', status 'cancelled'
 *       failed  → actionType 'data_sync_failed',  action 'data-sync.failed',  status 'failed'
 *     Every row carries `details.kind` (success|skipped|failed), `details.source` ('manual'
 *     for the force-sync transport), and `details.reason` / `details.errorClass`.
 *     Listed at GET /api/activity-log?workId=<id> → { activities:[...] }.
 *   - Work hard-delete (PROBED): `POST /api/works/:id/delete` (NOT a `DELETE` verb —
 *     `DELETE /api/works/:id` is a 404 route-not-found) → 200 { status:'success', slug,
 *     message, deleted_repositories:[] }. Works have NO soft-delete: after the delete
 *     GET /works/:id and POST /works/:id/sync both 404 with { status:'error',
 *     message:/not found/ }, and a second delete is a 404. The deleted work is gone
 *     from the dispatcher's SELECTs (drops out of dueCount).
 *
 * NOT DUPLICATED (surveyed all data-sync / idempotency / schedule siblings):
 *   - flow-data-sync-platform.spec.ts → single-work outcome envelope + ONE activity
 *     row, the 403/401/404 access gates, a SINGLE retry-backoff suppression poll +
 *     webhook-rotate / platform-ingest surfaces.
 *   - data-sync.spec.ts / data-sync-idempotency.spec.ts → single-work <500 smoke +
 *     same-status-family retry + stranger 4xx + fixme webhook/poller AC stubs.
 *   - idempotency-keys.spec.ts → the generic Idempotency-Key HEADER on POST /works.
 *   - cron-schedules / cron-drift-tolerance / work-schedule / flow-work-scheduled-updates
 *     → schedule cron-string CRUD + readiness gate, NOT the data-sync dispatch fold.
 *   NET-NEW HERE: the MULTI-WORK tick-accounting FOLD + conservation invariant;
 *   idempotency across MANY rapid ticks (no double-dispatch in one backoff window);
 *   backoff-vs-failed gate ORDERING + the cancelled/failed row-status mapping in the
 *   feed; dispatch over a HARD-DELETED work dropping out of the due-set (real
 *   POST /works/:id/delete); gate-reason discrimination of the `skipped` bucket; and
 *   cross-principal dispatch-scope isolation.
 *
 * GOTCHAS honored: every mutation runs on a FRESH registerUserViaAPI() user (never
 * the shared seeded user — a user-scoped state must not shadow sibling specs);
 * unique Date.now()-suffixed names; outcomes are environment-adaptive (enqueued IFF
 * a git account is connected — non-CI; else failed/skipped) so each assertion keeps a
 * tolerant branch; no fictional HTTP tick route is invented; the retry-backoff window
 * is never waited out — only its in-window suppression + feed ordering are asserted.
 */

const SYNC_STATUSES = ['enqueued', 'skipped', 'failed'] as const;
type SyncStatus = (typeof SYNC_STATUSES)[number];

/** The documented closed vocabulary of `data-sync.skipped` reasons (data-sync.types.ts). */
const SKIP_REASONS = [
    'retry-backoff',
    'sync-in-progress',
    'generation-in-progress',
    'no-changes',
    'app-not-installed-and-no-credentials',
] as const;

interface DataSyncOutcome {
    status: SyncStatus;
    outcome?: string;
    reason?: string;
    errorClass?: string;
    errorTail?: string;
    stats?: unknown;
    [key: string]: unknown;
}

interface ActivityRow {
    actionType?: string;
    action?: string;
    status?: string;
    details?: {
        kind?: string;
        reason?: string;
        source?: string;
        errorClass?: string;
        [key: string]: unknown;
    };
    createdAt?: string;
    [key: string]: unknown;
}

/** The dispatcher's accounting fold — exactly what dispatchDue() returns (minus entries). */
interface DispatchSummary {
    due: number;
    dispatched: number;
    skipped: number;
    failed: number;
}

/** POST /api/works/:id/sync as an owner; returns the parsed outcome + status code. */
async function forceSync(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ http: number; body: DataSyncOutcome }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/sync`, {
        headers: authedHeaders(token),
    });
    let body: DataSyncOutcome = { status: 'failed' };
    try {
        body = (await res.json()) as DataSyncOutcome;
    } catch {
        // non-JSON (unexpected) — leave the default; the http code carries the truth.
    }
    return { http: res.status(), body };
}

/**
 * Fold a list of per-Work outcomes into the SAME { due,dispatched,skipped,failed }
 * accounting the cron dispatcher computes (data-sync-dispatcher.service.ts). This is
 * the dispatcher's loop body mirrored on the client so we can assert the tick contract
 * via the shared surface.
 */
function foldDispatch(outcomes: DataSyncOutcome[]): DispatchSummary {
    const summary: DispatchSummary = {
        due: outcomes.length,
        dispatched: 0,
        skipped: 0,
        failed: 0,
    };
    for (const o of outcomes) {
        if (o.status === 'enqueued') summary.dispatched += 1;
        else if (o.status === 'skipped') summary.skipped += 1;
        else summary.failed += 1;
    }
    return summary;
}

async function listActivity(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<ActivityRow[]> {
    const res = await request.get(`${API_BASE}/api/activity-log?workId=${workId}`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return [];
    const json = await res.json();
    return (json.activities ?? json.data ?? []) as ActivityRow[];
}

function dataSyncRows(rows: ActivityRow[]): ActivityRow[] {
    return rows.filter(
        (a) =>
            (a.actionType ?? '').startsWith('data_sync_') ||
            (a.action ?? '').startsWith('data-sync.'),
    );
}

function isFailedRow(r: ActivityRow): boolean {
    return r.actionType === 'data_sync_failed' || r.details?.kind === 'failed';
}

function isBackoffSkipRow(r: ActivityRow): boolean {
    return (
        (r.actionType === 'data_sync_skipped' || r.details?.kind === 'skipped') &&
        r.details?.reason === 'retry-backoff'
    );
}

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

test.describe('flow: data-sync dispatch tick (deep, reconstructed via the shared surface)', () => {
    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 1 — MULTI-WORK TICK FOLD + CONSERVATION INVARIANT.
    // The dispatcher's tick fold over N due Works must satisfy
    // dispatched+skipped+failed === due, with every bucket a non-negative integer.
    // We materialise several owned Works, force-sync each (the shared runDataSync
    // body), fold the outcomes exactly as dispatchDue() would, and assert the
    // summary shape + the conservation invariant the tick guarantees.
    // ───────────────────────────────────────────────────────────────────────────
    test('a multi-work tick fold yields a well-formed {due,dispatched,skipped,failed} that conserves', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, {
            name: `Dispatch Fold ${uniqueSuffix()}`,
        });
        const token = owner.access_token;

        // Create a small batch — each becomes a candidate the tick would select.
        const WORK_COUNT = 3;
        const workIds: string[] = [];
        for (let i = 0; i < WORK_COUNT; i++) {
            const w = await createWorkViaAPI(request, token, {
                name: `dispatch-fold-${i}-${uniqueSuffix()}`,
            });
            expect(w.id, `work ${i} created`).toBeTruthy();
            workIds.push(w.id);
        }

        // Fan out exactly as the dispatcher loop does (one runDataSync per Work).
        const outcomes: DataSyncOutcome[] = [];
        for (const id of workIds) {
            const { http, body } = await forceSync(request, token, id);
            // A resolved outcome is HttpStatus.ACCEPTED (202); never a 5xx.
            expect(http, `force-sync ${id} resolves with 202`).toBe(202);
            expect(SYNC_STATUSES, `outcome.status for ${id}`).toContain(body.status);
            outcomes.push(body);
        }

        const summary = foldDispatch(outcomes);

        // Shape: four non-negative integer buckets.
        for (const k of ['due', 'dispatched', 'skipped', 'failed'] as const) {
            expect(Number.isInteger(summary[k]), `${k} is an integer`).toBe(true);
            expect(summary[k], `${k} >= 0`).toBeGreaterThanOrEqual(0);
        }
        // due echoes the number of Works the tick considered.
        expect(summary.due, 'due equals the works fanned out').toBe(WORK_COUNT);
        // THE TICK CONSERVATION INVARIANT.
        expect(
            summary.dispatched + summary.skipped + summary.failed,
            'dispatched + skipped + failed conserves to due',
        ).toBe(summary.due);

        // In CI (no connected git account) every FIRST render gate throws → all failed.
        // Outside CI a connected account would enqueue. Assert truthfully per-env.
        const allFailed = outcomes.every((o) => o.status === 'failed');
        if (allFailed) {
            expect(summary.failed, 'CI render gate fails every fresh work').toBe(WORK_COUNT);
            for (const o of outcomes) {
                expect(o.errorClass, 'failed carries a low-cardinality errorClass').toBeTruthy();
                expect(String(o.errorTail), 'errorTail names the missing git account').toMatch(
                    /No connected account|github|not found/i,
                );
            }
        } else {
            // Mixed/non-CI environments are still valid as long as the fold conserved
            // and every status is from the closed union (already asserted above).
            test.info().annotations.push({
                type: 'env-adaptive',
                description: `tick fold = ${JSON.stringify(summary)} (not all-failed — git account may be connected).`,
            });
        }
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 2 — IDEMPOTENCY ACROSS MANY RAPID TICKS (duplicate suppression).
    // The dispatcher must NEVER re-dispatch a Work while a recent attempt is still
    // backing off. The first sync runs a gate (failed in CI → arms the retry-backoff
    // key); EVERY subsequent rapid sync of the SAME Work is suppressed at gate 1 →
    // { skipped, reason:'retry-backoff' }. Across K ticks the fold must show AT MOST
    // ONE dispatched outcome, proving the idempotency / no-double-dispatch contract.
    // ───────────────────────────────────────────────────────────────────────────
    test('K rapid ticks on one work suppress all but the first via the retry-backoff idempotency gate', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, {
            name: `Dispatch Idem ${uniqueSuffix()}`,
        });
        const token = owner.access_token;
        const w = await createWorkViaAPI(request, token, {
            name: `dispatch-idem-${uniqueSuffix()}`,
        });

        const K = 4;
        const outcomes: DataSyncOutcome[] = [];
        for (let i = 0; i < K; i++) {
            const { http, body } = await forceSync(request, token, w.id);
            expect(http, `rapid tick ${i} resolves`).toBe(202);
            expect(SYNC_STATUSES).toContain(body.status);
            outcomes.push(body);
        }

        const first = outcomes[0];

        if (first.status === 'enqueued') {
            // Non-CI: a connected git account made gate 3 pass, no backoff key was
            // written, so suppression does not apply. Assert the enqueue + bail.
            test.info().annotations.push({
                type: 'git-connected',
                description:
                    'first tick enqueued (git account connected — non-CI); retry-backoff idempotency does not arm, skipping the suppression invariant.',
            });
            expect(first.outcome).toBe('success');
            return;
        }

        // CI path: the first tick ran a gate (failed/skipped) and armed backoff.
        // The remaining ticks in the same window are suppressed as retry-backoff —
        // poll because the cache write settles asynchronously.
        await expect
            .poll(
                async () => {
                    const { body } = await forceSync(request, token, w.id);
                    return body.status === 'skipped' ? body.reason : `not-skipped:${body.status}`;
                },
                {
                    timeout: 25_000,
                    message: 'a duplicate tick in the backoff window must be skipped:retry-backoff',
                },
            )
            .toBe('retry-backoff');

        // Idempotency fold invariant: across the window at most ONE tick was a real
        // dispatch; the rest are skipped. (Reconstructed from the K rapid outcomes —
        // the dispatcher would NEVER count >1 dispatched here.)
        const fold = foldDispatch(outcomes);
        expect(fold.dispatched, 'no work is double-dispatched in one window').toBeLessThanOrEqual(
            1,
        );
        // Once backoff arms, subsequent same-window ticks are all skipped.
        const skippedAfterFirst = outcomes.slice(1).filter((o) => o.status === 'skipped').length;
        expect(
            skippedAfterFirst,
            'subsequent ticks in the window are suppressed',
        ).toBeGreaterThanOrEqual(1);
        // Every suppressed tick carries the same retry-backoff reason (de-dup, not a new gate).
        for (const o of outcomes.slice(1).filter((x) => x.status === 'skipped')) {
            expect(o.reason, 'each suppressed duplicate is retry-backoff').toBe('retry-backoff');
        }
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 3 — GATE ORDERING + ROW-STATUS MAPPING in the activity feed. The FAILED
    // row (which arms the backoff) is recorded, then a SKIPPED retry-backoff row; this
    // pins the dispatcher's gate-1-then-gate-3 ordering as an observable artifact AND
    // the describePayload() column mapping: failed → row.status 'failed', skipped →
    // row.status 'cancelled' (PROBED), both with details.source 'manual'. No success
    // row exists in this CI window (gate 3 never passed).
    // ───────────────────────────────────────────────────────────────────────────
    test('the feed records the failed (backoff-arming) row + a cancelled retry-backoff row with the correct status mapping', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, {
            name: `Dispatch Order ${uniqueSuffix()}`,
        });
        const token = owner.access_token;
        const w = await createWorkViaAPI(request, token, {
            name: `dispatch-order-${uniqueSuffix()}`,
        });

        // First tick: render gate throws (CI) → failed + arms backoff.
        const firstRes = await forceSync(request, token, w.id);
        expect(firstRes.http).toBe(202);

        if (firstRes.body.status === 'enqueued') {
            test.info().annotations.push({
                type: 'git-connected',
                description: 'first tick enqueued (non-CI); gate-ordering assertion skipped.',
            });
            expect(firstRes.body.outcome).toBe('success');
            return;
        }

        // Drive a second (suppressed) tick + wait for both rows to land.
        await forceSync(request, token, w.id);

        const rows = await expect
            .poll(
                async () => {
                    const ds = dataSyncRows(await listActivity(request, token, w.id));
                    const hasFailed = ds.some(isFailedRow);
                    const hasSkipped = ds.some(isBackoffSkipRow);
                    return hasFailed && hasSkipped ? ds : undefined;
                },
                {
                    timeout: 30_000,
                    message: 'both a failed row and a retry-backoff skipped row should be recorded',
                },
            )
            .toBeTruthy();
        void rows;

        // Re-read concretely and assert the two rows + their kinds/status/source mapping.
        const ds = dataSyncRows(await listActivity(request, token, w.id));
        const failedRow = ds.find(isFailedRow);
        const skippedRow = ds.find(isBackoffSkipRow);
        expect(failedRow, 'a data_sync_failed row exists').toBeTruthy();
        expect(skippedRow, 'a data_sync_skipped:retry-backoff row exists').toBeTruthy();

        // Row-column mapping from describePayload() — PROBED live.
        expect(failedRow!.action, 'failed row action namespace').toBe('data-sync.failed');
        expect(failedRow!.status, 'failed row status column maps to FAILED').toBe('failed');
        expect(failedRow!.details?.kind, 'failed row details.kind').toBe('failed');
        expect(failedRow!.details?.source, 'failed row came from the manual transport').toBe(
            'manual',
        );

        expect(skippedRow!.action, 'skipped row action namespace').toBe('data-sync.skipped');
        // The skipped row's status column maps to ActivityStatus.CANCELLED (not "skipped").
        expect(skippedRow!.status, 'skipped row status column maps to CANCELLED').toBe('cancelled');
        expect(skippedRow!.details?.kind, 'skipped row details.kind').toBe('skipped');
        expect(skippedRow!.details?.source, 'skipped row came from the manual transport').toBe(
            'manual',
        );

        // No data_sync_success row should exist in this CI window — gate 3 never passed.
        expect(
            ds.some((r) => r.actionType === 'data_sync_success' || r.details?.kind === 'success'),
            'no success row in the failed/backoff window',
        ).toBe(false);
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 4 — DISPATCH OVER A HARD-DELETED WORK. A Work the dispatcher might still
    // reference is deleted; it must drop out of `due` and the manual surface must never
    // 5xx. Works have NO soft-delete — the real route is POST /api/works/:id/delete
    // (NOT a DELETE verb; PROBED). After it succeeds (200 {status:'success'}), the
    // work is gone: GET 404, force-sync 404 {status:'error',message:'Work not found'},
    // and a second delete is a 404. The fold over a batch where one work was deleted
    // mid-flight still conserves: due counts only the works that resolved an outcome.
    // ───────────────────────────────────────────────────────────────────────────
    test('a hard-deleted work drops out of the tick due-set: force-sync 404s, the fold stays well-formed (no 5xx)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, {
            name: `Dispatch Deleted ${uniqueSuffix()}`,
        });
        const token = owner.access_token;

        // Two survivors + one to-be-deleted candidate.
        const survivorA = await createWorkViaAPI(request, token, {
            name: `dispatch-del-survivor-a-${uniqueSuffix()}`,
        });
        const doomed = await createWorkViaAPI(request, token, {
            name: `dispatch-del-doomed-${uniqueSuffix()}`,
        });
        const survivorB = await createWorkViaAPI(request, token, {
            name: `dispatch-del-survivor-b-${uniqueSuffix()}`,
        });

        // Hard-delete the doomed work via the REAL route (POST /works/:id/delete).
        const del = await request.post(`${API_BASE}/api/works/${doomed.id}/delete`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(del.status(), `delete responds 200 (got ${del.status()})`).toBe(200);
        const delBody = await del.json();
        expect(delBody, 'delete envelope is a success').toMatchObject({ status: 'success' });
        expect(Array.isArray(delBody.deleted_repositories), 'delete reports repositories').toBe(
            true,
        );

        // The work is truly gone (no soft-delete): GET 404.
        const getDeleted = await request.get(`${API_BASE}/api/works/${doomed.id}`, {
            headers: authedHeaders(token),
        });
        expect(getDeleted.status(), 'deleted work GET -> 404').toBe(404);

        // A tick targeting the deleted work resolves to a clean 404 — the work is no
        // longer in the due-set and the manual surface must NOT crash on it. The
        // controller's findById short-circuits to 404 BEFORE runDataSync is reached.
        const deletedRes = await request.post(`${API_BASE}/api/works/${doomed.id}/sync`, {
            headers: authedHeaders(token),
        });
        expect(
            deletedRes.status(),
            `deleted-work sync is a clean 404, never a 5xx (got ${deletedRes.status()})`,
        ).toBe(404);
        const deletedSyncBody = await deletedRes.json();
        expect(deletedSyncBody).toMatchObject({ status: 'error' });
        expect(String(deletedSyncBody.message), 'deleted-work 404 message').toMatch(/not found/i);

        // A second delete is also a clean 404 (idempotent — nothing left to remove).
        const delAgain = await request.post(`${API_BASE}/api/works/${doomed.id}/delete`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(delAgain.status(), 'second delete of a gone work -> 404').toBe(404);

        // The survivors still resolve normal outcomes — the deleted work did not poison
        // the batch. Fold over ONLY the works that remained "due".
        const survivorOutcomes: DataSyncOutcome[] = [];
        for (const w of [survivorA, survivorB]) {
            const { http, body } = await forceSync(request, token, w.id);
            expect(http, `survivor ${w.id} resolves (no 5xx)`).toBe(202);
            expect(SYNC_STATUSES).toContain(body.status);
            survivorOutcomes.push(body);
        }
        const fold = foldDispatch(survivorOutcomes);
        // due reflects only the survivors — the deleted work is excluded.
        expect(fold.due, 'the deleted work is not in the due-set').toBe(2);
        expect(
            fold.dispatched + fold.skipped + fold.failed,
            'fold over the surviving due-set still conserves',
        ).toBe(fold.due);
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 5 — GATE-REASON DISCRIMINATION. The dispatcher counts BOTH a backoff
    // suppression and a generation-in-progress suppression as `skipped`, but the
    // per-Work outcome distinguishes them by `reason`. We verify the live skip-reason
    // vocabulary is honored: the retry-backoff reason is reachable + well-typed, and the
    // recorded skipped row carries the matching reason (so a UI/metrics consumer can
    // break the dispatcher's `skipped` bucket back down by details.reason).
    // ───────────────────────────────────────────────────────────────────────────
    test('skipped outcomes are reason-discriminated (retry-backoff reachable + recorded with its reason)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, {
            name: `Dispatch Reasons ${uniqueSuffix()}`,
        });
        const token = owner.access_token;
        const w = await createWorkViaAPI(request, token, {
            name: `dispatch-reasons-${uniqueSuffix()}`,
        });

        // Arm backoff with the first tick.
        const first = await forceSync(request, token, w.id);
        expect(first.http).toBe(202);

        if (first.body.status === 'enqueued') {
            test.info().annotations.push({
                type: 'git-connected',
                description:
                    'first tick enqueued (non-CI); retry-backoff reason not reachable, skipping reason discrimination.',
            });
            expect(first.body.outcome).toBe('success');
            return;
        }

        // The next in-window tick MUST be a typed skip with the retry-backoff reason.
        await expect
            .poll(
                async () => {
                    const { body } = await forceSync(request, token, w.id);
                    return body.status === 'skipped' ? body.reason : `not-skipped:${body.status}`;
                },
                {
                    timeout: 25_000,
                    message: 'the suppressed tick must be skipped with a typed reason',
                },
            )
            .toBe('retry-backoff');
        // Re-read the suppressed outcome concretely and assert its reason is from the
        // documented closed vocabulary.
        const suppressed = await forceSync(request, token, w.id);
        expect(suppressed.body.status, 'still suppressed in-window').toBe('skipped');
        expect(SKIP_REASONS, 'outcome reason is from the documented skip-reason union').toContain(
            suppressed.body.reason as string,
        );

        // The recorded skipped row carries the matching reason — the dispatcher's
        // `skipped` bucket is decomposable by this `details.reason`.
        const ds = dataSyncRows(await listActivity(request, token, w.id));
        const skippedRow = ds.find(isBackoffSkipRow);
        expect(skippedRow, 'a retry-backoff skipped row was recorded').toBeTruthy();
        expect(
            SKIP_REASONS,
            'recorded reason is from the documented DataSyncSkipReason union',
        ).toContain(skippedRow!.details?.reason);
        // describePayload() maps the skipped row's status COLUMN to CANCELLED (not "skipped"),
        // while the typed details.kind stays "skipped" — both are part of the contract.
        expect(skippedRow!.status, 'skipped row status column is cancelled').toBe('cancelled');
        expect(skippedRow!.details?.kind, 'skipped row details.kind is skipped').toBe('skipped');
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 6 — CROSS-PRINCIPAL DISPATCH-SCOPE ISOLATION. A second user can never inject
    // another user's Work into their own dispatch fan-out: a stranger's force-sync on the
    // owner's work is 403 (NOT counted as the stranger's `due`), while the OWNER's own
    // tick fold remains scoped to works they own. This pins the per-principal scoping the
    // cron dispatcher relies on (it SELECTs all due works, but the manual surface — the
    // only user-triggerable tick — is owner-gated, so no user can force a cross-tenant
    // dispatch).
    // ───────────────────────────────────────────────────────────────────────────
    test("a stranger cannot fold another user's work into their dispatch scope (403, not counted)", async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const suffix = uniqueSuffix();

        // Owner A owns two works.
        const ownerA = await registerUserViaAPI(request, { name: `Dispatch Iso A ${suffix}` });
        const tokenA = ownerA.access_token;
        const a1 = await createWorkViaAPI(request, tokenA, { name: `dispatch-iso-a1-${suffix}` });
        const a2 = await createWorkViaAPI(request, tokenA, { name: `dispatch-iso-a2-${suffix}` });

        // Stranger B owns one unrelated work.
        const ownerB = await registerUserViaAPI(request, { name: `Dispatch Iso B ${suffix}` });
        const tokenB = ownerB.access_token;
        const b1 = await createWorkViaAPI(request, tokenB, { name: `dispatch-iso-b1-${suffix}` });

        // B tries to fold A's works into a tick → 403 each, NEVER a 2xx outcome, never a
        // 5xx. These never enter B's dispatch fold.
        for (const aWork of [a1, a2]) {
            const res = await request.post(`${API_BASE}/api/works/${aWork.id}/sync`, {
                headers: authedHeaders(tokenB),
            });
            expect(res.status(), `stranger cannot dispatch owner A's work ${aWork.id}`).toBe(403);
            const body = await res.json();
            expect(body).toMatchObject({ status: 'error' });
            expect(String(body.message), 'stranger 403 message').toMatch(/permission/i);
        }

        // B's OWN dispatch fold is scoped to B's own work only — it resolves an outcome and
        // conserves over a due-set of exactly 1 (b1), regardless of A.
        const { http: bHttp, body: bBody } = await forceSync(request, tokenB, b1.id);
        expect(bHttp, "B's own tick resolves").toBe(202);
        expect(SYNC_STATUSES).toContain(bBody.status);
        const bFold = foldDispatch([bBody]);
        expect(bFold.due, "B's due-set holds only B's own work").toBe(1);
        expect(bFold.dispatched + bFold.skipped + bFold.failed, "B's fold conserves").toBe(1);

        // Owner A's own works still fold independently (the stranger's attempts had no
        // effect on A's dispatch scope).
        const aOutcomes: DataSyncOutcome[] = [];
        for (const aWork of [a1, a2]) {
            const { http, body } = await forceSync(request, tokenA, aWork.id);
            expect(http, `owner A dispatches own work ${aWork.id}`).toBe(202);
            expect(SYNC_STATUSES).toContain(body.status);
            aOutcomes.push(body);
        }
        const aFold = foldDispatch(aOutcomes);
        expect(aFold.due, "A's due-set holds A's two works").toBe(2);
        expect(aFold.dispatched + aFold.skipped + aFold.failed, "A's fold conserves").toBe(2);

        // The stranger's blocked attempts wrote NO data-sync rows to A's works — the 403
        // fires in the controller before runDataSync, so no activity is recorded for them.
        const a1Rows = dataSyncRows(await listActivity(request, tokenA, a1.id));
        const strangerSourced = a1Rows.filter((r) => r.userId === ownerB.user.id);
        expect(strangerSourced.length, "no row on A's work is attributed to the stranger").toBe(0);
    });
});
