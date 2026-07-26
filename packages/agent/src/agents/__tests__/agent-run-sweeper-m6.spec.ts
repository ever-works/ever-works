import { AgentRunSweeperService } from '../agent-run-sweeper.service';
import {
    ATTENTION_REASON_QUEUED_TOO_LONG,
    STALE_PARK_SUMMARY_PREFIX,
} from '../../database/repositories/agent-run.repository';

/**
 * State-aware sweeper policy (orchestration M6).
 *
 * The pre-M6 sweeper had ONE verdict (`failed`) for three different
 * situations. These tests pin the three branches the plan specifies:
 *
 *   - `running` + stale  → checkpoint-and-PARK (resumable), not a hard fail
 *   - `queued`  + stale  → reap (nothing started, nothing to checkpoint)
 *   - `queued`  + over the queued bound → SURFACE (flag + notify), never reap
 *
 * plus the rule that outranks all three: an `awaitingInput` run is exempt
 * from every one of them.
 */
describe('AgentRunSweeperService — state-aware policy (M6)', () => {
    const ENV_KEYS = [
        'AGENT_RUN_SWEEPER_ENABLED',
        'AGENT_RUN_STUCK_SWEEP_MINUTES',
        'AGENT_RUN_STUCK_SWEEP_BATCH',
        'AGENT_MAX_RUN_DURATION_SECONDS',
        'AGENT_RUN_STALE_PARK_ENABLED',
        'AGENT_RUN_QUEUED_TOO_LONG_MINUTES',
        'AGENT_RUN_QUEUED_ATTENTION_BATCH',
    ];
    let saved: Record<string, string | undefined>;
    let runs: any;
    let notifications: any;
    let escalations: any;

    function makeSvc(): AgentRunSweeperService {
        const svc = new AgentRunSweeperService(runs, undefined, notifications, escalations);
        for (const level of ['warn', 'log'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    }

    function row(over: Record<string, unknown> = {}) {
        return {
            id: 'r1',
            agentId: 'a1',
            userId: 'u1',
            triggerKind: 'task',
            status: 'running',
            startedAt: new Date(Date.now() - 24 * 60 * 60_000),
            createdAt: new Date(Date.now() - 24 * 60 * 60_000),
            ...over,
        };
    }

    beforeEach(() => {
        saved = {};
        for (const k of ENV_KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
        runs = {
            findStuckNonTerminal: jest.fn().mockResolvedValue([]),
            markStuckFailed: jest.fn().mockResolvedValue(0),
            parkStaleRunning: jest.fn().mockResolvedValue(0),
            findQueuedTooLong: jest.fn().mockResolvedValue([]),
            setAttention: jest.fn().mockResolvedValue(true),
            findById: jest.fn().mockResolvedValue({ id: 'r1', userId: 'u1' }),
        };
        notifications = { notifyAgentRunQueuedTooLong: jest.fn().mockResolvedValue(undefined) };
        escalations = { record: jest.fn().mockResolvedValue({ id: 'e1' }) };
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        jest.restoreAllMocks();
    });

    describe('stale running → checkpoint-and-park', () => {
        it('⭐ parks a stale running run instead of hard-failing it', async () => {
            // THE M6 TEST. A dead worker does not mean bad work: the
            // conversation is still resumable, so the run must come back as
            // a parked row with a Resume button, not a red error row.
            runs.findStuckNonTerminal.mockResolvedValue([row({ status: 'running' })]);
            runs.parkStaleRunning.mockResolvedValue(1);

            const summary = await makeSvc().sweepStuckRuns();

            expect(runs.parkStaleRunning).toHaveBeenCalledWith(['r1'], expect.any(String));
            expect(runs.markStuckFailed).not.toHaveBeenCalled();
            expect(summary.parked).toBe(1);
            expect(summary.swept).toBe(1);
        });

        it('stamps a summary a human can act on, not an error string', async () => {
            runs.findStuckNonTerminal.mockResolvedValue([row({ status: 'running' })]);
            runs.parkStaleRunning.mockResolvedValue(1);
            await makeSvc().sweepStuckRuns();
            const summary: string = runs.parkStaleRunning.mock.calls[0][1];
            expect(summary).toContain(STALE_PARK_SUMMARY_PREFIX);
            expect(summary).toContain('resume');
        });

        it('reaps a stale QUEUED run — there is no conversation to park', async () => {
            runs.findStuckNonTerminal.mockResolvedValue([
                row({ id: 'q1', status: 'queued', startedAt: null }),
            ]);
            runs.markStuckFailed.mockResolvedValue(1);

            const summary = await makeSvc().sweepStuckRuns();

            expect(runs.markStuckFailed).toHaveBeenCalledWith(['q1'], expect.any(String));
            expect(runs.parkStaleRunning).not.toHaveBeenCalled();
            expect(summary.parked).toBe(0);
        });

        it('splits a mixed batch: running parked, queued reaped, in one tick', async () => {
            runs.findStuckNonTerminal.mockResolvedValue([
                row({ id: 'run-a', status: 'running' }),
                row({ id: 'queued-b', status: 'queued', startedAt: null }),
            ]);
            runs.parkStaleRunning.mockResolvedValue(1);
            runs.markStuckFailed.mockResolvedValue(1);

            const summary = await makeSvc().sweepStuckRuns();

            expect(runs.parkStaleRunning).toHaveBeenCalledWith(['run-a'], expect.any(String));
            expect(runs.markStuckFailed).toHaveBeenCalledWith(['queued-b'], expect.any(String));
            expect(summary.parked).toBe(1);
            expect(summary.swept).toBe(2);
        });

        it('falls back to the pre-M6 hard fail when the park valve is off', async () => {
            // The rollback valve has to actually roll back, or it is not a
            // valve — it is a comment.
            process.env.AGENT_RUN_STALE_PARK_ENABLED = 'false';
            runs.findStuckNonTerminal.mockResolvedValue([row({ status: 'running' })]);
            runs.markStuckFailed.mockResolvedValue(1);

            const summary = await makeSvc().sweepStuckRuns();

            expect(runs.parkStaleRunning).not.toHaveBeenCalled();
            expect(runs.markStuckFailed).toHaveBeenCalledWith(['r1'], expect.any(String));
            expect(summary.parked).toBe(0);
        });

        it('files a run-parked escalation so the parked run is not silently orphaned', async () => {
            runs.findStuckNonTerminal.mockResolvedValue([row({ status: 'running' })]);
            runs.parkStaleRunning.mockResolvedValue(1);

            await makeSvc().sweepStuckRuns();

            expect(escalations.record).toHaveBeenCalledWith(
                expect.objectContaining({ reasonCode: 'run-parked', runId: 'r1', userId: 'u1' }),
            );
        });
    });

    describe('queued-too-long → surface, never reap', () => {
        it('⭐ flags and notifies without transitioning the run', async () => {
            // THE "DO NOT REAP" HALF. Killing queued work to hide a capacity
            // problem is exactly the failure this pass exists to prevent, so
            // the assertion that NOTHING was transitioned is the point.
            runs.findQueuedTooLong.mockResolvedValue([
                row({ status: 'queued', createdAt: new Date(Date.now() - 120 * 60_000) }),
            ]);

            const summary = await makeSvc().sweepQueuedTooLong();

            expect(runs.setAttention).toHaveBeenCalledWith('r1', ATTENTION_REASON_QUEUED_TOO_LONG);
            expect(runs.markStuckFailed).not.toHaveBeenCalled();
            expect(runs.parkStaleRunning).not.toHaveBeenCalled();
            expect(notifications.notifyAgentRunQueuedTooLong).toHaveBeenCalledWith(
                expect.objectContaining({ runId: 'r1', userId: 'u1' }),
            );
            expect(summary).toEqual(
                expect.objectContaining({ flagged: 1, notified: 1, scanned: 1 }),
            );
        });

        it('does not notify twice when the flag CAS is lost to another replica', async () => {
            runs.findQueuedTooLong.mockResolvedValue([row({ status: 'queued' })]);
            runs.setAttention.mockResolvedValue(false);

            const summary = await makeSvc().sweepQueuedTooLong();

            expect(notifications.notifyAgentRunQueuedTooLong).not.toHaveBeenCalled();
            expect(escalations.record).not.toHaveBeenCalled();
            expect(summary.flagged).toBe(0);
        });

        it('honours the configurable threshold when computing the cutoff', async () => {
            process.env.AGENT_RUN_QUEUED_TOO_LONG_MINUTES = '15';
            await makeSvc().sweepQueuedTooLong();
            const cutoff: Date = runs.findQueuedTooLong.mock.calls[0][0];
            const ageMinutes = (Date.now() - cutoff.getTime()) / 60_000;
            expect(Math.round(ageMinutes)).toBe(15);
        });

        it('is disabled by a zero threshold and scans nothing', async () => {
            process.env.AGENT_RUN_QUEUED_TOO_LONG_MINUTES = '0';
            const summary = await makeSvc().sweepQueuedTooLong();
            expect(summary.enabled).toBe(false);
            expect(runs.findQueuedTooLong).not.toHaveBeenCalled();
        });

        it('is disabled with the sweeper kill switch', async () => {
            process.env.AGENT_RUN_SWEEPER_ENABLED = 'false';
            const summary = await makeSvc().sweepQueuedTooLong();
            expect(summary.enabled).toBe(false);
            expect(runs.findQueuedTooLong).not.toHaveBeenCalled();
        });

        it('keeps flagging the rest of the batch when one notification throws', async () => {
            // A notification channel outage must not stop the FLAGS, which
            // are what the Sessions filter reads.
            runs.findQueuedTooLong.mockResolvedValue([
                row({ id: 'a', status: 'queued' }),
                row({ id: 'b', status: 'queued' }),
            ]);
            notifications.notifyAgentRunQueuedTooLong.mockRejectedValueOnce(new Error('smtp'));

            const summary = await makeSvc().sweepQueuedTooLong();

            expect(summary.flagged).toBe(2);
            expect(summary.notified).toBe(1);
        });
    });
});
