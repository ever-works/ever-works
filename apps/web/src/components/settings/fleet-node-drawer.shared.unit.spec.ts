import { describe, expect, it } from 'vitest';
import type { FleetJobView, FleetNodeJobHistoryEntry } from '@ever-works/contracts';
import {
    FLEET_JOB_FILTERS,
    filterFleetJobs,
    fleetJobDurationMs,
    fleetJobOutcomeKey,
    fleetJobOutcomeText,
    fleetWorkerStateBadgeClass,
    fleetWorkerStateKey,
    formatFleetJobDuration,
} from './fleet-node-drawer.shared';

function job(over: Partial<FleetJobView> = {}): FleetJobView {
    return {
        id: 'job-1',
        kind: 'agent-task',
        status: 'done',
        nodeId: 'node-1',
        targetNodeId: null,
        requiredCapabilities: [],
        payload: null,
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: '2026-09-01T10:00:00.000Z',
        startedAt: '2026-09-01T10:00:05.000Z',
        completedAt: '2026-09-01T10:01:17.000Z',
        queuedReason: null,
        ...over,
    };
}

describe('filterFleetJobs', () => {
    const jobs = [
        job({ id: 'queued', status: 'queued', startedAt: null, completedAt: null }),
        job({ id: 'leased', status: 'leased', completedAt: null }),
        job({ id: 'running', status: 'running', completedAt: null }),
        job({ id: 'done', status: 'done' }),
        job({ id: 'failed', status: 'failed' }),
    ];

    it('exposes the chips in All / Failed / Running order', () => {
        expect(FLEET_JOB_FILTERS).toEqual(['all', 'failed', 'running']);
    });

    it('"all" returns a copy of every job in the original order', () => {
        const result = filterFleetJobs(jobs, 'all');
        expect(result.map((entry) => entry.id)).toEqual([
            'queued',
            'leased',
            'running',
            'done',
            'failed',
        ]);
        expect(result).not.toBe(jobs);
    });

    it('"failed" keeps only failed jobs', () => {
        expect(filterFleetJobs(jobs, 'failed').map((entry) => entry.id)).toEqual(['failed']);
    });

    /**
     * The chip has to agree with the badge sitting next to it (EW-776).
     * Judging the filter on `job.status` while the badge is judged on the
     * reconciled run outcome would put a row rendering a red "Failed" in
     * All and hide it under Failed — the original defect, one layer up.
     */
    it('"failed" is judged on the RECONCILED outcome, not the job status', () => {
        const rows = [
            {
                ...job({ id: 'done-but-run-failed', status: 'done' }),
                reconciled: { runId: 'r1', status: 'failed' as const, summary: null, error: null },
            },
            {
                ...job({ id: 'failed-but-run-completed', status: 'failed' }),
                reconciled: {
                    runId: 'r2',
                    status: 'completed' as const,
                    summary: null,
                    error: null,
                },
            },
            { ...job({ id: 'failed-no-run', status: 'failed' }), reconciled: null },
        ];

        expect(filterFleetJobs(rows, 'failed').map((entry) => entry.id)).toEqual([
            'done-but-run-failed',
            'failed-no-run',
        ]);
    });

    /**
     * A leased job is claimed and about to run; hiding it would make a
     * node that just picked up work look idle until its first heartbeat.
     */
    it('"running" keeps every job a node currently holds a claim on', () => {
        expect(filterFleetJobs(jobs, 'running').map((entry) => entry.id)).toEqual([
            'leased',
            'running',
        ]);
    });
});

describe('fleetJobDurationMs', () => {
    const NOW = new Date('2026-09-01T10:03:00.000Z').getTime();

    it('is null for a job that never started', () => {
        expect(fleetJobDurationMs(job({ startedAt: null }), NOW)).toBeNull();
    });

    it('measures a completed job between its two stamps', () => {
        expect(fleetJobDurationMs(job(), NOW)).toBe(72_000);
    });

    it('measures a job still running against the injected clock', () => {
        expect(fleetJobDurationMs(job({ status: 'running', completedAt: null }), NOW)).toBe(
            175_000,
        );
    });

    it('clamps clock skew to zero instead of going negative', () => {
        expect(fleetJobDurationMs(job({ completedAt: '2026-09-01T10:00:01.000Z' }), NOW)).toBe(0);
    });

    it('is null for an unparseable stamp', () => {
        expect(fleetJobDurationMs(job({ startedAt: 'not a date' }), NOW)).toBeNull();
    });
});

describe('formatFleetJobDuration', () => {
    it('renders sub-second spans in milliseconds', () => {
        expect(formatFleetJobDuration(820)).toBe('820ms');
    });

    it('renders seconds, then minutes with seconds, then hours with minutes', () => {
        expect(formatFleetJobDuration(12_000)).toBe('12s');
        expect(formatFleetJobDuration(252_000)).toBe('4m 12s');
        expect(formatFleetJobDuration(5_640_000)).toBe('1h 34m');
    });

    it('returns null for an unknown span so the caller renders a dash', () => {
        expect(formatFleetJobDuration(null)).toBeNull();
        expect(formatFleetJobDuration(undefined)).toBeNull();
        expect(formatFleetJobDuration(-1)).toBeNull();
        expect(formatFleetJobDuration(Number.NaN)).toBeNull();
    });
});

/**
 * Fleet health signals (EW-776) — the drawer's new derivations.
 *
 * Two of these encode the defect directly: a node reads `online` while
 * its worker is quarantined, and a job reads `done` while the run it
 * carried failed. Both used to render as "fine".
 */

function historyJob(over: Partial<FleetNodeJobHistoryEntry> = {}): FleetNodeJobHistoryEntry {
    return { ...job(), error: null, summary: null, reconciled: null, ...over };
}

const reconciled = (
    over: Partial<NonNullable<FleetNodeJobHistoryEntry['reconciled']>> = {},
): NonNullable<FleetNodeJobHistoryEntry['reconciled']> => ({
    runId: 'run-1',
    status: 'completed',
    summary: null,
    error: null,
    ...over,
});

describe('fleetWorkerStateKey', () => {
    it.each([['idle'], ['working'], ['paused'], ['quarantined'], ['throttled']] as const)(
        'passes %s through',
        (workerState) => {
            expect(fleetWorkerStateKey({ workerState })).toBe(workerState);
        },
    );

    it('reports unknown — never idle — for a node that has never said', () => {
        // A fabricated readiness for a machine we know nothing about is
        // the exact lie this feature exists to end.
        expect(fleetWorkerStateKey({ workerState: null })).toBe('unknown');
        expect(fleetWorkerStateKey({})).toBe('unknown');
    });

    it('reports unknown for a value this build does not recognise', () => {
        expect(fleetWorkerStateKey({ workerState: 'hibernating' as never })).toBe('unknown');
    });
});

describe('fleetWorkerStateBadgeClass', () => {
    it('makes a quarantine stand out and leaves idle neutral', () => {
        expect(fleetWorkerStateBadgeClass('quarantined')).toContain('danger');
        expect(fleetWorkerStateBadgeClass('throttled')).toContain('warning');
        expect(fleetWorkerStateBadgeClass('paused')).toContain('warning');
        expect(fleetWorkerStateBadgeClass('working')).toContain('info');
        // An idle machine is not an event.
        expect(fleetWorkerStateBadgeClass('idle')).not.toContain('danger');
        expect(fleetWorkerStateBadgeClass('unknown')).not.toContain('danger');
    });
});

describe('fleetJobOutcomeKey', () => {
    it('reports a FAILED run behind a job the node called done', () => {
        expect(
            fleetJobOutcomeKey(
                historyJob({ status: 'done', reconciled: reconciled({ status: 'failed' }) }),
            ),
        ).toBe('failed');
    });

    it('keeps saying running while the reconciler has not settled the run', () => {
        // "Completed" here would repeat the original mistake with fresher
        // data: the JOB finished, the WORK has not.
        expect(
            fleetJobOutcomeKey(
                historyJob({ status: 'done', reconciled: reconciled({ status: 'running' }) }),
            ),
        ).toBe('running');
    });

    it('surfaces a cancelled run', () => {
        expect(
            fleetJobOutcomeKey(historyJob({ reconciled: reconciled({ status: 'cancelled' }) })),
        ).toBe('cancelled');
    });

    it.each([
        ['done', 'completed'],
        ['failed', 'failed'],
        ['running', 'running'],
        ['leased', 'running'],
        ['queued', 'queued'],
    ] as const)('falls back to the job status %s → %s when no run is known', (status, expected) => {
        expect(fleetJobOutcomeKey(historyJob({ status, reconciled: null }))).toBe(expected);
    });
});

describe('fleetJobOutcomeText', () => {
    it('leads with the RUN error — the reconciled reason is the one that matters', () => {
        const text = fleetJobOutcomeText(
            historyJob({
                error: 'job said: exit 1',
                reconciled: reconciled({ status: 'failed', error: 'model refused the plan' }),
            }),
        );
        expect(text).toBe('model refused the plan');
    });

    it("falls back to the job's own error", () => {
        expect(fleetJobOutcomeText(historyJob({ error: 'pnpm install exploded' }))).toBe(
            'pnpm install exploded',
        );
    });

    it('shows the run summary only when nothing went wrong', () => {
        expect(
            fleetJobOutcomeText(
                historyJob({ reconciled: reconciled({ summary: 'Added a guard' }) }),
            ),
        ).toBe('Added a guard');
    });

    it('returns null when there is nothing to say', () => {
        expect(fleetJobOutcomeText(historyJob())).toBeNull();
        expect(fleetJobOutcomeText(historyJob({ error: '   ' }))).toBeNull();
    });

    it('truncates so a pasted stack trace cannot take over the drawer', () => {
        const text = fleetJobOutcomeText(historyJob({ error: 'x'.repeat(400) }), 240);
        expect(text).toHaveLength(241);
        expect(text?.endsWith('…')).toBe(true);
    });
});
