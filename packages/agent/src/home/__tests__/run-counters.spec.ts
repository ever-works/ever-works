import type { RunLedgerRow, RunWindowStats } from '@ever-works/contracts';
import { HomeRunsBuilder, toHomeRunCounters, toHomeWorkingNow } from '../builders/runs.builder';
import type { HomeBuildContext } from '../home-build-context';

const NOW = new Date('2026-09-14T07:04:00.000Z');
const MINUTE = 60 * 1000;

function row(overrides: Partial<RunLedgerRow> = {}): RunLedgerRow {
    return {
        id: 'run-1',
        agentId: 'agent-1',
        agentName: 'Research',
        agentArchived: false,
        triggerKind: 'task',
        status: 'running',
        startedAt: new Date(NOW.getTime() - 14 * MINUTE).toISOString(),
        createdAt: new Date(NOW.getTime() - 15 * MINUTE).toISOString(),
        finishedAt: null,
        durationMs: null,
        costCents: null,
        totalTokens: null,
        summary: null,
        errorMessage: null,
        currentActivity: 'Reading the September changelog',
        taskId: null,
        taskTitle: null,
        missionId: null,
        missionTitle: null,
        workId: null,
        workName: null,
        scheduleKey: null,
        awaitingInput: false,
        queuedReason: null,
        attentionReason: null,
        ...overrides,
    };
}

function stats(byStatus: Partial<RunWindowStats['byStatus']>): RunWindowStats {
    return {
        window: {
            granularity: 'day',
            anchorDate: '2026-09-14',
            from: '2026-09-14T00:00:00.000Z',
            to: '2026-09-15T00:00:00.000Z',
            timezone: 'UTC',
            clamped: false,
        },
        total: 0,
        byStatus: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, ...byStatus },
        byTrigger: {},
        successRate: null,
        errorCount: 0,
        totalDurationMs: 0,
        costCents: null,
        unsettledRuns: 0,
        tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
        repeatFailures: [],
    };
}

function context(): HomeBuildContext {
    return {
        userId: 'user-1',
        scope: { tenantId: 'tenant-1', organizationId: 'org-1' },
        timezone: 'Europe/Kyiv',
        day: {
            date: '2026-09-14',
            from: new Date('2026-09-13T21:00:00.000Z'),
            to: new Date('2026-09-14T21:00:00.000Z'),
        },
        now: NOW,
        memo: new Map(),
    };
}

describe('Home run counters and Working now', () => {
    it('computes elapsed time from the build clock and cuts the activity line to 100 characters', () => {
        const result = toHomeWorkingNow([row({ currentActivity: 'y'.repeat(250) })], 1, NOW);
        expect(result.rows[0].elapsedMs).toBe(14 * MINUTE);
        expect(result.rows[0].activity).toHaveLength(100);
    });

    it('keeps a missing activity line null so the web can say "Working…"', () => {
        expect(
            toHomeWorkingNow([row({ currentActivity: null })], 1, NOW).rows[0].activity,
        ).toBeNull();
    });

    it('caps rows at 5 and keeps the exact total', () => {
        const rows = Array.from({ length: 7 }, (_, index) => row({ id: `run-${index}` }));
        const result = toHomeWorkingNow(rows, 12, NOW);
        expect(result.rows).toHaveLength(5);
        expect(result.total).toBe(12);
    });

    it('reads done and failed today off the ledger day stats, never capping the numbers', () => {
        expect(toHomeRunCounters(2, stats({ completed: 1500, failed: 1 }))).toEqual({
            workingNow: 2,
            doneToday: 1500,
            failedToday: 1,
        });
    });

    describe('HomeRunsBuilder', () => {
        function builder() {
            const agentRuns = {
                listSessionsForUser: jest.fn().mockResolvedValue([[{ id: 'run-1' }], 3]),
            };
            const runLedger = {
                toRows: jest.fn().mockResolvedValue([row()]),
                getStats: jest.fn().mockResolvedValue(stats({ completed: 7, failed: 1 })),
            };
            return {
                agentRuns,
                runLedger,
                subject: new HomeRunsBuilder(runLedger as never, agentRuns as never),
            };
        }

        it('lists running runs that are not waiting on a human, longest-running first, in scope (S15)', async () => {
            const { agentRuns, subject } = builder();
            const ctx = context();

            await subject.workingNow(ctx);

            expect(agentRuns.listSessionsForUser).toHaveBeenCalledWith(
                'user-1',
                { status: 'running', awaitingInput: false, order: 'longest-running' },
                5,
                0,
                ctx.scope,
            );
        });

        it('shares the running read between Working now and the counters in one build', async () => {
            const { agentRuns, runLedger, subject } = builder();
            const ctx = context();

            const [working, counters] = await Promise.all([
                subject.workingNow(ctx),
                subject.counters(ctx),
            ]);

            expect(agentRuns.listSessionsForUser).toHaveBeenCalledTimes(1);
            expect(working.total).toBe(3);
            expect(counters).toEqual({ workingNow: 3, doneToday: 7, failedToday: 1 });
            expect(runLedger.getStats).toHaveBeenCalledWith(
                'user-1',
                { granularity: 'day', timezone: 'Europe/Kyiv', now: NOW },
                ctx.scope,
            );
        });

        it('reports its source as unavailable when the ledger is not wired', async () => {
            await expect(new HomeRunsBuilder().counters(context())).rejects.toMatchObject({
                name: 'HomeSourceUnavailableError',
            });
        });
    });
});
