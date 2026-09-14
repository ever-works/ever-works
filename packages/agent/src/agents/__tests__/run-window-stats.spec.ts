import type { RunLedgerWindow } from '@ever-works/contracts';
import type { RunLedgerAggregateRow } from '../../database/repositories/agent-run.repository';
import {
    computeRepeatFailures,
    computeRunWindowStats,
    heartbeatScheduleKey,
    runSuccessRate,
    scheduleKeyForRun,
} from '../run-window-stats';

/**
 * Runs ledger (AW-09) — the rail's numbers, computed from grouped rows.
 *
 * The honesty rules are the point: a rate over nothing is null, a cost no
 * run carries is null (not $0.00), and a schedule needs a second failure
 * before it is blamed.
 */
describe('run-window-stats', () => {
    const WINDOW: RunLedgerWindow = {
        granularity: 'day',
        anchorDate: '2026-09-13',
        from: '2026-09-13T00:00:00.000Z',
        to: '2026-09-14T00:00:00.000Z',
        timezone: 'UTC',
        clamped: false,
    };

    function group(over: Partial<RunLedgerAggregateRow>): RunLedgerAggregateRow {
        return {
            status: 'completed',
            triggerKind: 'task',
            runs: 1,
            durationMs: 0,
            costCents: 0,
            costedRuns: 0,
            tokens: 0,
            tokenRuns: 0,
            ...over,
        };
    }

    describe('runSuccessRate', () => {
        it('is null with zero terminal runs', () => {
            expect(runSuccessRate(0, 0)).toBeNull();
        });

        it('rounds to one decimal place', () => {
            expect(runSuccessRate(27, 29)).toBe(93.1);
            expect(runSuccessRate(1, 3)).toBe(33.3);
            expect(runSuccessRate(3, 3)).toBe(100);
        });
    });

    describe('schedule keys', () => {
        it('uses the unified schedule list key for heartbeat runs only', () => {
            expect(heartbeatScheduleKey('a1')).toBe('agent_heartbeat:a1');
            expect(scheduleKeyForRun({ triggerKind: 'heartbeat', agentId: 'a1' })).toBe(
                'agent_heartbeat:a1',
            );
            expect(scheduleKeyForRun({ triggerKind: 'task', agentId: 'a1' })).toBeNull();
            expect(scheduleKeyForRun({ triggerKind: 'manual', agentId: 'a1' })).toBeNull();
        });
    });

    describe('computeRunWindowStats', () => {
        it('reports zeros and nulls for an empty window — never fabricated figures', () => {
            const stats = computeRunWindowStats(WINDOW, [], [], new Map());
            expect(stats.total).toBe(0);
            expect(stats.successRate).toBeNull();
            expect(stats.errorCount).toBe(0);
            expect(stats.costCents).toBeNull();
            expect(stats.tokens.total).toBeNull();
            expect(stats.byStatus).toEqual({
                queued: 0,
                running: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
            });
            expect(stats.repeatFailures).toEqual([]);
        });

        it('suppresses the success rate while every run is still in flight', () => {
            const stats = computeRunWindowStats(
                WINDOW,
                [group({ status: 'running', runs: 2 }), group({ status: 'queued', runs: 1 })],
                [],
                new Map(),
            );
            expect(stats.total).toBe(3);
            expect(stats.successRate).toBeNull();
        });

        it('counts cancelled runs as terminal but not as errors', () => {
            const stats = computeRunWindowStats(
                WINDOW,
                [
                    group({ status: 'completed', runs: 2 }),
                    group({ status: 'failed', runs: 1 }),
                    group({ status: 'cancelled', runs: 1 }),
                ],
                [],
                new Map(),
            );
            expect(stats.successRate).toBe(50);
            expect(stats.errorCount).toBe(1);
        });

        it('folds groups by trigger and sums durations, cost and tokens', () => {
            const stats = computeRunWindowStats(
                WINDOW,
                [
                    group({
                        triggerKind: 'heartbeat',
                        runs: 2,
                        durationMs: 1000,
                        costCents: 40,
                        costedRuns: 2,
                        tokens: 900,
                        tokenRuns: 2,
                    }),
                    group({
                        triggerKind: 'task',
                        status: 'failed',
                        runs: 1,
                        durationMs: 500,
                        costCents: 0,
                        costedRuns: 0,
                        tokens: 0,
                        tokenRuns: 0,
                    }),
                ],
                [],
                new Map(),
            );
            expect(stats.byTrigger).toEqual({ heartbeat: 2, task: 1 });
            expect(stats.totalDurationMs).toBe(1500);
            expect(stats.costCents).toBe(40);
            expect(stats.unsettledRuns).toBe(1);
            expect(stats.tokens.total).toBe(900);
            expect(stats.tokens.input).toBeNull();
        });

        it('tolerates the string / NULL values drivers return for sums', () => {
            const stats = computeRunWindowStats(
                WINDOW,
                [
                    {
                        status: 'completed',
                        triggerKind: 'chat',
                        runs: '3' as unknown as number,
                        durationMs: null as unknown as number,
                        costCents: '12' as unknown as number,
                        costedRuns: '1' as unknown as number,
                        tokens: null as unknown as number,
                        tokenRuns: '0' as unknown as number,
                    },
                ],
                [],
                new Map(),
            );
            expect(stats.total).toBe(3);
            expect(stats.totalDurationMs).toBe(0);
            expect(stats.costCents).toBe(12);
            expect(stats.tokens.total).toBeNull();
        });
    });

    describe('computeRepeatFailures', () => {
        const names = new Map([
            ['a1', 'Ops'],
            ['a2', 'Research'],
        ]);

        it('ignores a schedule with exactly one failure', () => {
            expect(computeRepeatFailures([{ agentId: 'a1', failures: 1 }], names)).toEqual([]);
        });

        it('flags two and three failures, most failures first, with the agent name', () => {
            expect(
                computeRepeatFailures(
                    [
                        { agentId: 'a1', failures: 2 },
                        { agentId: 'a2', failures: 3 },
                        { agentId: 'gone', failures: 2 },
                    ],
                    names,
                ),
            ).toEqual([
                {
                    scheduleKey: 'agent_heartbeat:a2',
                    agentId: 'a2',
                    agentName: 'Research',
                    failures: 3,
                },
                { scheduleKey: 'agent_heartbeat:a1', agentId: 'a1', agentName: 'Ops', failures: 2 },
                {
                    scheduleKey: 'agent_heartbeat:gone',
                    agentId: 'gone',
                    agentName: null,
                    failures: 2,
                },
            ]);
        });
    });
});
