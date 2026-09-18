import {
    APP_DIVERGENCE_TTL_MS,
    APP_FORK_READINESS_IDLE_MS,
    APP_FORK_READINESS_MAX_REDISPATCH,
    APP_UPSTREAM_SYNC_DISPATCH_BATCH,
} from '@ever-works/contracts';
import {
    AppUpstreamSyncDispatcherService,
    APP_UPSTREAM_DIVERGENCE_WINDOW_MS,
    type AppUpstreamDispatchCounters,
} from '../app-upstream-sync-dispatcher.service';
import {
    APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS,
    APP_SETUP_PULL_REQUEST_ON_VIEW_MS,
} from '../app-upstream-state.service';
import { computeNextUpstreamSync } from '../upstream-schedule';

/**
 * APW-02 T28 — the dispatcher tick (plan §6.6, `plan.md:800-816`; spec FR-23, FR-41,
 * FR-46, FR-52). ACC-02-07, ACC-02-13, ACC-02-16, ACC-02-17.
 *
 * The claims this spec exists to pin:
 *
 *   1. **The batch is capped at 50** and every claimed row is either dispatched,
 *      skipped or counted — nothing is silently dropped (§6.6).
 *   2. **The next slot is stamped before the job is queued**, so a failing Work cannot
 *      hot-loop; a rate-limited Work is deliberately **not** stamped, because the whole
 *      point of that skip is that it resumes the moment the limit lifts (ACC-02-16).
 *   3. **A lost readiness job is restarted within ten minutes, at most three times**,
 *      and is `timed_out` after that (FR-23, ACC-02-07).
 *   4. **An `unavailable` upstream is re-checked daily** by queueing a real sync — the
 *      only thing that can observe the upstream reading back (FR-41, ACC-02-17).
 *   5. **The on-view divergence compare is queued when the reading is older than ten
 *      minutes and at most once per ten minutes per Work** (FR-46, ACC-02-13).
 *   6. **A tick never throws**: a leg whose own read fails is counted and the other legs
 *      still run.
 *
 * Every collaborator is a plain object double — the service under test is the whole
 * subject here, and the three ports are exactly the three seams §6.6 names. The
 * repository double records its calls in `order`, which is how "stamped **before** the
 * dispatch" is asserted rather than assumed.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORK_ID = '33333333-3333-4333-8333-333333333333';

/** A Monday, 00:00 UTC — the default schedule's own day, so the slot is deterministic. */
const NOW = Date.parse('2026-01-05T00:00:00.000Z');
const MINUTE = 60_000;

/** A state row as `WorkUpstreamStateRepository` returns it. */
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        workId: WORK_ID,
        relation: 'fork',
        readinessState: 'ready',
        readinessDispatches: 0,
        readinessHeartbeatAt: null,
        syncSchedule: null,
        nextSyncAt: new Date(NOW),
        rateLimitedUntil: null,
        divergenceComputedAt: null,
        upstreamStatus: 'available',
        upstreamCheckedAt: null,
        // T43's three columns — the on-view door reads exactly these.
        setupPullRequestNumber: null,
        setupCheckedAt: null,
        ...overrides,
    };
}

interface Harness {
    service: AppUpstreamSyncDispatcherService;
    rows: {
        claimDue: jest.Mock;
        findStalePreparing: jest.Mock;
        findUnavailableDueForRecheck: jest.Mock;
        /** T43's claim — the fourth leg reads it, so every harness models it. */
        claimSetupPullRequestChecks: jest.Mock;
        update: jest.Mock;
        findByWorkId: jest.Mock;
    };
    states: { timeout: jest.Mock; checkSetupPullRequest: jest.Mock };
    sync: { dispatch: jest.Mock };
    readiness: { dispatch: jest.Mock };
    /** Every repository write and every dispatch, in the order they happened. */
    order: string[];
}

function build(
    options: {
        due?: Record<string, unknown>[];
        stale?: Record<string, unknown>[];
        unavailable?: Record<string, unknown>[];
        /** Rows the setup-pull-request claim hands over (T43's fourth leg). */
        setupChecks?: Record<string, unknown>[];
        row?: Record<string, unknown> | null;
        bindSync?: boolean;
        bindReadiness?: boolean;
        /** Overrides the outcome `checkSetupPullRequest` answers with. */
        setupCheckResult?: Record<string, unknown>;
    } = {},
): Harness {
    const order: string[] = [];

    const rows = {
        claimDue: jest.fn().mockResolvedValue(options.due ?? []),
        findStalePreparing: jest.fn().mockResolvedValue(options.stale ?? []),
        findUnavailableDueForRecheck: jest.fn().mockResolvedValue(options.unavailable ?? []),
        claimSetupPullRequestChecks: jest.fn(
            async (nowMs: number, minIntervalMs: number, limit: number) => {
                order.push(`claimSetupPullRequestChecks:${minIntervalMs}:${limit}`);
                return options.setupChecks ?? [];
            },
        ),
        update: jest.fn(async (workId: string, patch: Record<string, unknown>) => {
            order.push(`update:${workId}:${Object.keys(patch).sort().join(',')}`);
            return true;
        }),
        findByWorkId: jest.fn().mockResolvedValue(options.row ?? null),
    };

    const states = {
        timeout: jest.fn().mockResolvedValue({ found: true, state: 'timed_out', emitted: true }),
        checkSetupPullRequest: jest.fn(async (workId: string): Promise<Record<string, unknown>> => {
            order.push(`checkSetupPullRequest:${workId}`);
            return options.setupCheckResult ?? { found: true, checked: true, status: 'open' };
        }),
    };

    const sync = {
        dispatch: jest.fn(async (payload: { workId: string; trigger: string }) => {
            order.push(`dispatch:${payload.workId}:${payload.trigger}`);
            return `run-${payload.workId}-${payload.trigger}`;
        }),
    };

    const readiness = {
        dispatch: jest.fn(async (payload: { workId: string; attempt: number }) => {
            order.push(`readiness:${payload.workId}:${payload.attempt}`);
            return `run-readiness-${payload.workId}`;
        }),
    };

    const service = new AppUpstreamSyncDispatcherService(
        rows as never,
        states as never,
        options.bindSync === false ? undefined : (sync as never),
        options.bindReadiness === false ? undefined : (readiness as never),
    );

    return { service, rows, states, sync, readiness, order };
}

/** The slot the service must stamp for a row with no stored schedule. */
const DEFAULT_SLOT = (workId: string): Date =>
    computeNextUpstreamSync(null, new Date(NOW), workId) as Date;

describe('AppUpstreamSyncDispatcherService', () => {
    describe('the due rows — §6.6 leg 1 (FR-52, ACC-02-16)', () => {
        it('claims at most 50 rows per tick and dispatches each one once', async () => {
            const due = Array.from({ length: 60 }, (_unused, index) =>
                makeRow({ workId: `work-${index}` }),
            );
            const h = build({ due });

            const counters = await h.service.dispatchDue(NOW);

            // 60 rows are handed over by the double; the cap is what the service asks for.
            expect(h.rows.claimDue).toHaveBeenCalledTimes(1);
            expect(h.rows.claimDue).toHaveBeenCalledWith(NOW, APP_UPSTREAM_SYNC_DISPATCH_BATCH);
            expect(APP_UPSTREAM_SYNC_DISPATCH_BATCH).toBe(50);
            expect(h.sync.dispatch).toHaveBeenCalledTimes(60);
            expect(counters.dueCount).toBe(60);
            expect(counters.dispatched).toBe(60);
            expect(counters.failed).toBe(0);
            expect(counters.skipped).toBe(0);
        });

        it('stamps the real next slot BEFORE queueing the job, never the claim lease', async () => {
            const h = build({ due: [makeRow()] });

            await h.service.dispatchDue(NOW);

            const slot = DEFAULT_SLOT(WORK_ID);
            expect(h.rows.update).toHaveBeenCalledWith(WORK_ID, { nextSyncAt: slot });
            // The order is the claim: `stamp-before-dispatch` is what stops a Work whose
            // every run dies from being re-claimed on the very next tick. The third entry is
            // T43's fourth leg, which claims after the other three — a tick's writes are one
            // sequence, so the assertion stays exact rather than filtered.
            expect(h.order).toEqual([
                `update:${WORK_ID}:nextSyncAt`,
                `dispatch:${WORK_ID}:schedule`,
                `claimSetupPullRequestChecks:${APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS}:${APP_UPSTREAM_SYNC_DISPATCH_BATCH}`,
            ]);
            // …and the stamped slot is a real future instant, not the +10 min lease.
            expect(slot.getTime()).toBeGreaterThan(NOW);
            expect(slot.getTime()).not.toBe(NOW + 600_000);
        });

        it('stamps the row’s own stored schedule when it has one', async () => {
            const h = build({ due: [makeRow({ syncSchedule: '*/30 * * * *' })] });

            await h.service.dispatchDue(NOW);

            const expected = computeNextUpstreamSync('*/30 * * * *', new Date(NOW), WORK_ID);
            expect(h.rows.update).toHaveBeenCalledWith(WORK_ID, { nextSyncAt: expected });
        });

        it('skips a Work inside its rate-limit window and leaves it on the claim lease', async () => {
            const h = build({
                due: [makeRow({ rateLimitedUntil: new Date(NOW + 5 * MINUTE) })],
            });

            const counters = await h.service.dispatchDue(NOW);

            expect(h.sync.dispatch).not.toHaveBeenCalled();
            // ACC-02-16: the skip is re-evaluated every tick, so nothing may push this
            // row to a next *slot* — that is up to a week away for the default cron.
            expect(h.rows.update).not.toHaveBeenCalled();
            expect(counters.dueCount).toBe(1);
            expect(counters.dispatched).toBe(0);
            expect(counters.skipped).toBe(1);
        });

        it('dispatches a rate-limited Work again once the stored window has passed', async () => {
            const h = build({
                due: [makeRow({ rateLimitedUntil: new Date(NOW - MINUTE) })],
            });

            const counters = await h.service.dispatchDue(NOW);

            expect(h.sync.dispatch).toHaveBeenCalledWith({ workId: WORK_ID, trigger: 'schedule' });
            expect(counters.dispatched).toBe(1);
            expect(counters.skipped).toBe(0);
        });

        it('never dispatches a link relation — a link has no upstream at all (FR-44)', async () => {
            const h = build({ due: [makeRow({ relation: 'link' })] });

            const counters = await h.service.dispatchDue(NOW);

            expect(h.sync.dispatch).not.toHaveBeenCalled();
            expect(counters.skipped).toBe(1);
            expect(counters.dispatched).toBe(0);
        });

        it('counts a dispatch that produced no run id as failed, never as dispatched', async () => {
            const h = build({ due: [makeRow()] });
            h.sync.dispatch.mockResolvedValue(null);

            const counters = await h.service.dispatchDue(NOW);

            expect(counters.dueCount).toBe(1);
            expect(counters.dispatched).toBe(0);
            expect(counters.failed).toBe(1);
        });

        it('counts an unbound sync dispatcher as failed for every claimed row', async () => {
            const h = build({
                due: [makeRow(), makeRow({ workId: OTHER_WORK_ID })],
                bindSync: false,
            });

            const counters = await h.service.dispatchDue(NOW);

            expect(counters.dueCount).toBe(2);
            expect(counters.dispatched).toBe(0);
            expect(counters.failed).toBe(2);
        });

        it('counts a dispatcher that throws as failed and keeps going', async () => {
            const h = build({ due: [makeRow(), makeRow({ workId: OTHER_WORK_ID })] });
            h.sync.dispatch.mockRejectedValueOnce(new Error('queue down'));

            const counters = await h.service.dispatchDue(NOW);

            expect(counters.dispatched).toBe(1);
            expect(counters.failed).toBe(1);
        });
    });

    describe('the stale readiness sweep — §6.6 leg 2 (FR-23, ACC-02-07)', () => {
        it('looks for jobs silent for ten minutes, in the same 50-row batch', async () => {
            const h = build();

            await h.service.dispatchDue(NOW);

            expect(h.rows.findStalePreparing).toHaveBeenCalledWith(
                NOW,
                APP_FORK_READINESS_IDLE_MS,
                APP_UPSTREAM_SYNC_DISPATCH_BATCH,
            );
            expect(APP_FORK_READINESS_IDLE_MS).toBe(600_000);
        });

        it('restarts a lost job, bumping the attempt and the heartbeat before queueing', async () => {
            const h = build({ stale: [makeRow({ readinessState: 'preparing' })] });

            const counters = await h.service.dispatchDue(NOW);

            expect(h.rows.update).toHaveBeenCalledWith(WORK_ID, {
                readinessDispatches: 1,
                readinessHeartbeatAt: new Date(NOW),
            });
            expect(h.readiness.dispatch).toHaveBeenCalledWith({
                workId: WORK_ID,
                attempt: 1,
                reason: 'redispatch',
            });
            expect(h.order).toEqual([
                `update:${WORK_ID}:readinessDispatches,readinessHeartbeatAt`,
                `readiness:${WORK_ID}:1`,
                `claimSetupPullRequestChecks:${APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS}:${APP_UPSTREAM_SYNC_DISPATCH_BATCH}`,
            ]);
            expect(counters.redispatchedReadiness).toBe(1);
            expect(counters.timedOut).toBe(0);
        });

        it('re-dispatches at most three times, then times the row out', async () => {
            // Four ticks of one Work whose job never reports: attempts 0, 1, 2 restart it;
            // attempt 3 is the allowance spent and ends the attempt as `timed_out`.
            const attempts = [0, 1, 2, 3];
            const seen: number[] = [];
            const timedOut: number[] = [];

            for (const readinessDispatches of attempts) {
                const h = build({
                    stale: [makeRow({ readinessState: 'preparing', readinessDispatches })],
                });
                const counters = await h.service.dispatchDue(NOW);
                if (h.readiness.dispatch.mock.calls.length > 0) {
                    seen.push(
                        (h.readiness.dispatch.mock.calls[0][0] as { attempt: number }).attempt,
                    );
                }
                if (h.states.timeout.mock.calls.length > 0) {
                    timedOut.push((h.states.timeout.mock.calls[0] as number[])[1]);
                }
                expect(counters.redispatchedReadiness + counters.timedOut).toBe(1);
            }

            expect(APP_FORK_READINESS_MAX_REDISPATCH).toBe(3);
            expect(seen).toEqual([1, 2, 3]);
            expect(timedOut).toEqual([3]);
        });

        it('times a spent row out through the state service and queues nothing', async () => {
            const h = build({
                stale: [makeRow({ readinessState: 'preparing', readinessDispatches: 3 })],
            });

            const counters = await h.service.dispatchDue(NOW);

            expect(h.states.timeout).toHaveBeenCalledWith(WORK_ID, 3);
            expect(h.readiness.dispatch).not.toHaveBeenCalled();
            expect(h.rows.update).not.toHaveBeenCalled();
            expect(counters.timedOut).toBe(1);
            expect(counters.redispatchedReadiness).toBe(0);
        });

        it('counts a restarted job that produced no run id as failed', async () => {
            const h = build({ stale: [makeRow({ readinessState: 'preparing' })] });
            h.readiness.dispatch.mockResolvedValue(null);

            const counters = await h.service.dispatchDue(NOW);

            expect(counters.redispatchedReadiness).toBe(0);
            expect(counters.failed).toBe(1);
        });

        it('counts an unbound readiness dispatcher as failed rather than a restart', async () => {
            const h = build({
                stale: [makeRow({ readinessState: 'preparing' })],
                bindReadiness: false,
            });

            const counters = await h.service.dispatchDue(NOW);

            expect(counters.redispatchedReadiness).toBe(0);
            expect(counters.failed).toBe(1);
        });
    });

    describe('the daily upstream re-check — §6.6 leg 3 (FR-41, ACC-02-17)', () => {
        it('queues a real sync for an unavailable upstream, capped at 50', async () => {
            const h = build({ unavailable: [makeRow({ upstreamStatus: 'unavailable' })] });

            const counters = await h.service.dispatchDue(NOW);

            expect(h.rows.findUnavailableDueForRecheck).toHaveBeenCalledWith(
                NOW,
                APP_UPSTREAM_SYNC_DISPATCH_BATCH,
            );
            expect(h.sync.dispatch).toHaveBeenCalledWith({ workId: WORK_ID, trigger: 'schedule' });
            expect(counters.rechecked).toBe(1);
        });

        it('leaves the slot to the run — a paused row has none to protect', async () => {
            const h = build({
                unavailable: [makeRow({ upstreamStatus: 'unavailable', nextSyncAt: null })],
            });

            await h.service.dispatchDue(NOW);

            // The run is what writes `available` and the next slot when the upstream reads
            // back, and what re-stamps `upstreamCheckedAt` when it does not. Nothing here
            // may race it with a slot computed from a schedule the upstream cannot honour.
            expect(h.rows.update).not.toHaveBeenCalledWith(WORK_ID, {
                nextSyncAt: expect.anything(),
            });
        });

        it('never re-checks a link row', async () => {
            const h = build({ unavailable: [makeRow({ relation: 'link' })] });

            const counters = await h.service.dispatchDue(NOW);

            expect(h.sync.dispatch).not.toHaveBeenCalled();
            expect(counters.skipped).toBe(1);
        });
    });

    describe('the on-view divergence compare — §4.1 (FR-46, ACC-02-13)', () => {
        it('queues one compare when the stored reading is older than ten minutes', async () => {
            const h = build({
                row: makeRow({ divergenceComputedAt: new Date(NOW - APP_DIVERGENCE_TTL_MS - 1) }),
            });

            const runId = await h.service.requestDivergenceCompare(WORK_ID, NOW);

            expect(runId).toBe(`run-${WORK_ID}-divergence`);
            expect(h.sync.dispatch).toHaveBeenCalledWith({
                workId: WORK_ID,
                trigger: 'divergence',
            });
        });

        it('queues one compare when the Work has no reading at all', async () => {
            const h = build({ row: makeRow({ divergenceComputedAt: null }) });

            await h.service.requestDivergenceCompare(WORK_ID, NOW);

            expect(h.sync.dispatch).toHaveBeenCalledTimes(1);
        });

        it('never queues a second compare inside the 600 s window', async () => {
            const h = build({
                row: makeRow({ divergenceComputedAt: new Date(NOW - APP_DIVERGENCE_TTL_MS - 1) }),
            });

            const first = await h.service.requestDivergenceCompare(WORK_ID, NOW);
            const second = await h.service.requestDivergenceCompare(WORK_ID, NOW + MINUTE * 9);
            const third = await h.service.requestDivergenceCompare(WORK_ID, NOW + 599_000);

            expect(first).not.toBeNull();
            expect(second).toBeNull();
            expect(third).toBeNull();
            expect(h.sync.dispatch).toHaveBeenCalledTimes(1);
            expect(APP_UPSTREAM_DIVERGENCE_WINDOW_MS).toBe(600_000);
        });

        it('queues again once the window has passed', async () => {
            const h = build({
                row: makeRow({ divergenceComputedAt: new Date(NOW - APP_DIVERGENCE_TTL_MS - 1) }),
            });

            await h.service.requestDivergenceCompare(WORK_ID, NOW);
            const later = await h.service.requestDivergenceCompare(WORK_ID, NOW + 600_000);

            expect(later).not.toBeNull();
            expect(h.sync.dispatch).toHaveBeenCalledTimes(2);
        });

        it('does not queue while the stored reading is still fresh', async () => {
            const h = build({
                row: makeRow({ divergenceComputedAt: new Date(NOW - MINUTE) }),
            });

            const runId = await h.service.requestDivergenceCompare(WORK_ID, NOW);

            expect(runId).toBeNull();
            expect(h.sync.dispatch).not.toHaveBeenCalled();
        });

        it('never queues for a link relation or a missing row', async () => {
            const link = build({ row: makeRow({ relation: 'link' }) });
            const missing = build({ row: null });

            await expect(link.service.requestDivergenceCompare(WORK_ID, NOW)).resolves.toBeNull();
            await expect(
                missing.service.requestDivergenceCompare(WORK_ID, NOW),
            ).resolves.toBeNull();

            expect(link.sync.dispatch).not.toHaveBeenCalled();
            expect(missing.sync.dispatch).not.toHaveBeenCalled();
        });

        it('does not open the window when nothing was queued', async () => {
            const h = build({
                row: makeRow({ divergenceComputedAt: new Date(NOW - APP_DIVERGENCE_TTL_MS - 1) }),
                bindSync: false,
            });

            const first = await h.service.requestDivergenceCompare(WORK_ID, NOW);
            const second = await h.service.requestDivergenceCompare(WORK_ID, NOW + MINUTE);

            expect(first).toBeNull();
            expect(second).toBeNull();
            // Two reads, because an unbound dispatcher held nothing back: the next view
            // must be free to try again rather than be throttled by a dispatch that never
            // happened.
            expect(h.rows.findByWorkId).toHaveBeenCalledTimes(2);
        });

        it('answers null for an empty Work id without touching the repository', async () => {
            const h = build({ row: makeRow() });

            await expect(h.service.requestDivergenceCompare('   ', NOW)).resolves.toBeNull();

            expect(h.rows.findByWorkId).not.toHaveBeenCalled();
            expect(h.sync.dispatch).not.toHaveBeenCalled();
        });
    });

    describe('a tick never throws', () => {
        it('counts a leg whose read threw and still runs the other legs', async () => {
            const h = build({ unavailable: [makeRow({ upstreamStatus: 'unavailable' })] });
            h.rows.claimDue.mockRejectedValueOnce(new Error('database is down'));

            const counters = await h.service.dispatchDue(NOW);

            expect(counters.failed).toBe(1);
            expect(counters.dueCount).toBe(0);
            // The other three legs still ran.
            expect(h.rows.findStalePreparing).toHaveBeenCalledTimes(1);
            expect(h.rows.findUnavailableDueForRecheck).toHaveBeenCalledTimes(1);
            expect(counters.rechecked).toBe(1);
        });

        it('counts a readiness leg whose read threw without losing the sync leg', async () => {
            const h = build({ due: [makeRow()] });
            h.rows.findStalePreparing.mockRejectedValueOnce(new Error('database is down'));

            const counters = await h.service.dispatchDue(NOW);

            expect(counters.dispatched).toBe(1);
            expect(counters.failed).toBe(1);
        });

        it('reports the setup pull request counter as 0 when nothing is waiting — that leg is T43’s', async () => {
            const h = build();

            const counters: AppUpstreamDispatchCounters = await h.service.dispatchDue(NOW);

            expect(counters.setupChecked).toBe(0);
            expect(h.rows.claimSetupPullRequestChecks).toHaveBeenCalledWith(
                NOW,
                APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS,
                APP_UPSTREAM_SYNC_DISPATCH_BATCH,
            );
            expect(Object.keys(counters).sort()).toEqual(
                [
                    'dispatched',
                    'dueCount',
                    'failed',
                    'rechecked',
                    'redispatchedReadiness',
                    'setupChecked',
                    'skipped',
                    'timedOut',
                ].sort(),
            );
        });
    });

    /**
     * §6.6's fourth leg (FR-24a, APW-02 T43) — the half that did not exist when the other three
     * landed, and therefore the half nothing was testing.
     */
    describe('the setup pull request check — §6.6 leg 4 (FR-24a, ACC-02-22)', () => {
        it('claims with the plan’s interval and batch, and reads every claimed row once', async () => {
            const waiting = [makeRow({ workId: 'work-a' }), makeRow({ workId: 'work-b' })];
            const h = build({ setupChecks: waiting });

            const counters = await h.service.dispatchDue(NOW);

            // The interval is the plan's 600 000 ms (`tasks.md:562`) and the batch is the same
            // ceiling the other three legs use — one shared number, not a fourth opinion.
            expect(h.rows.claimSetupPullRequestChecks).toHaveBeenCalledTimes(1);
            expect(h.rows.claimSetupPullRequestChecks).toHaveBeenCalledWith(
                NOW,
                APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS,
                APP_UPSTREAM_SYNC_DISPATCH_BATCH,
            );
            expect(APP_SETUP_PULL_REQUEST_CHECK_INTERVAL_MS).toBe(600_000);

            expect(h.states.checkSetupPullRequest).toHaveBeenCalledTimes(2);
            expect(h.states.checkSetupPullRequest).toHaveBeenCalledWith('work-a');
            expect(h.states.checkSetupPullRequest).toHaveBeenCalledWith('work-b');
            expect(counters.setupChecked).toBe(2);
            expect(counters.failed).toBe(0);
        });

        it('counts an unreadable provider as failed, not as a check that answered', async () => {
            // The distinction the counter exists for: "we asked and could not read" is the
            // condition an operator needs to see, and it must not be laundered into a success.
            const h = build({
                setupChecks: [makeRow({ workId: 'work-unreadable' })],
                setupCheckResult: { found: true, checked: true, status: 'unknown' },
            });

            const counters = await h.service.dispatchDue(NOW);

            expect(counters.setupChecked).toBe(0);
            expect(counters.failed).toBe(1);
        });

        it('still runs when an earlier leg threw — a broken sweep must not silence the check', async () => {
            const h = build({ setupChecks: [makeRow({ workId: 'work-c' })] });
            h.rows.findStalePreparing.mockRejectedValueOnce(new Error('database is down'));

            const counters = await h.service.dispatchDue(NOW);

            expect(counters.failed).toBe(1); // the sweep leg
            expect(counters.setupChecked).toBe(1); // and the check still happened
        });
    });

    /**
     * §4.1's on-view half of the same check (ACC-02-22): the member merges the setup pull
     * request, reloads the card, and must not have to wait for the next tick — but a burst of
     * reloads must still produce at most one provider read a minute.
     */
    describe('the on-view setup pull request check (ACC-02-22)', () => {
        const waitingRow = (setupCheckedAt: Date | null) =>
            makeRow({
                readinessState: 'waiting_for_setup_pr',
                setupPullRequestNumber: 12,
                setupCheckedAt,
            });

        it('checks a waiting row whose last check is older than 60 000 ms', async () => {
            const h = build({
                row: waitingRow(new Date(NOW - APP_SETUP_PULL_REQUEST_ON_VIEW_MS - 1)),
            });

            const result = await h.service.requestSetupPullRequestCheck(WORK_ID, NOW);

            expect(APP_SETUP_PULL_REQUEST_ON_VIEW_MS).toBe(60_000);
            expect(h.states.checkSetupPullRequest).toHaveBeenCalledTimes(1);
            expect(h.states.checkSetupPullRequest).toHaveBeenCalledWith(WORK_ID);
            expect(result?.status).toBe('open');
        });

        it('checks a waiting row that has never been checked', async () => {
            const h = build({ row: waitingRow(null) });

            await h.service.requestSetupPullRequestCheck(WORK_ID, NOW);

            expect(h.states.checkSetupPullRequest).toHaveBeenCalledTimes(1);
        });

        it('does not check again inside the 60 000 ms window', async () => {
            const h = build({
                row: waitingRow(new Date(NOW - APP_SETUP_PULL_REQUEST_ON_VIEW_MS + 1)),
            });

            const result = await h.service.requestSetupPullRequestCheck(WORK_ID, NOW);

            expect(result).toBeNull();
            expect(h.states.checkSetupPullRequest).not.toHaveBeenCalled();
        });

        it('does not check a row that is not waiting on a setup pull request', async () => {
            for (const row of [
                makeRow({ readinessState: 'ready', setupPullRequestNumber: 12 }),
                makeRow({ readinessState: 'waiting_for_setup_pr', setupPullRequestNumber: null }),
                makeRow({
                    readinessState: 'waiting_for_setup_pr',
                    setupPullRequestNumber: 12,
                    relation: 'link',
                }),
            ]) {
                const h = build({ row });
                const result = await h.service.requestSetupPullRequestCheck(WORK_ID, NOW);
                expect(result).toBeNull();
                expect(h.states.checkSetupPullRequest).not.toHaveBeenCalled();
            }
        });

        it('answers null for a blank id and never reaches the repository', async () => {
            const h = build({ row: waitingRow(null) });

            expect(await h.service.requestSetupPullRequestCheck('   ', NOW)).toBeNull();
            expect(h.rows.findByWorkId).not.toHaveBeenCalled();
            expect(h.states.checkSetupPullRequest).not.toHaveBeenCalled();
        });
    });
});
