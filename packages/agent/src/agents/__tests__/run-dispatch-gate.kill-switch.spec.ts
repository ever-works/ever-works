import {
    QUEUED_REASON_CONCURRENCY,
    QUEUED_REASON_KILL_SWITCH,
    RunDispatchGateService,
} from '../run-dispatch-gate.service';
import { KILL_SWITCH_ACTIVE_ERROR_NAME } from '../run-kill-switch';
import { AgentRunSweeperService } from '../agent-run-sweeper.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Panic controls (EW-778) — the dispatch gate with the `RUN_KILL_SWITCH`
 * port bound, and the two things that make a stop RECOVERABLE:
 *
 *   - `drainForWork(workId, 'kill-switch')` promotes a parked run through
 *     the SAME claim / enqueue / stamp path as a concurrency drain, and
 *     relabels one the chain now refuses for another reason;
 *   - `promoteParked` walks every Work with a parked run, bounded;
 *   - the stuck-run sweeper leaves `kill-switch`-parked rows alone, or a
 *     stop longer than the stuck timeout would fail every parked run and a
 *     clear would resume nothing.
 */
describe('RunDispatchGateService — kill switch (EW-778)', () => {
    const ENV_KEYS = [
        'AGENT_MAX_CONCURRENT_RUNS_PER_WORK',
        'AGENT_MAX_CONCURRENT_RUNS_PER_ORG',
        'CREDITS_ENFORCEMENT',
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};

    let runs: any;
    let dispatcher: any;
    let killSwitch: { shouldHaltDispatch: jest.Mock };

    const parkedRun = (over: Record<string, unknown> = {}) => ({
        id: 'run-parked',
        agentId: 'agent-1',
        userId: 'user-1',
        taskId: 'task-1',
        workId: 'work-1',
        organizationId: null,
        status: 'queued',
        queuedReason: QUEUED_REASON_KILL_SWITCH,
        ...over,
    });

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        runs = {
            countInFlightForWork: jest.fn().mockResolvedValue(0),
            countInFlightForUser: jest.fn().mockResolvedValue(0),
            countInFlightForOrganization: jest.fn().mockResolvedValue(0),
            findOldestQueuedForConcurrency: jest.fn().mockResolvedValue(null),
            claimQueuedForDispatch: jest.fn().mockResolvedValue(true),
            restoreQueuedReason: jest.fn().mockResolvedValue(undefined),
            relabelQueuedReason: jest.fn().mockResolvedValue(true),
            findQueuedWorkIdsByReason: jest.fn().mockResolvedValue([]),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        killSwitch = { shouldHaltDispatch: jest.fn().mockResolvedValue(false) };
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    // The port is the SIXTH positional argument (appended LAST).
    const makeGate = () =>
        new RunDispatchGateService(
            runs,
            dispatcher,
            undefined,
            undefined,
            undefined,
            killSwitch as never,
        );

    describe('admit', () => {
        it('parks every new run with `kill-switch` while the flag is set', async () => {
            killSwitch.shouldHaltDispatch.mockResolvedValue(true);
            const result = await makeGate().admit({ userId: 'user-1', workId: 'work-1' });
            expect(result).toEqual({ admitted: false, queuedReason: QUEUED_REASON_KILL_SWITCH });
            expect(runs.countInFlightForWork).not.toHaveBeenCalled();
        });

        it('admits as before while the flag is clear', async () => {
            const result = await makeGate().admit({ userId: 'user-1', workId: 'work-1' });
            expect(result).toEqual({ admitted: true });
            expect(killSwitch.shouldHaltDispatch).toHaveBeenCalledTimes(1);
        });

        /**
         * The critical-section path is the one that FAILS OPEN on a
         * throwing chain. A port that throws must still reach `reserve`
         * as a PARK verdict — that is the fail-closed contract crossing
         * the fail-open seam.
         */
        it('reserves a PARKED row when the port throws, even through the fail-open wrapper', async () => {
            killSwitch.shouldHaltDispatch.mockRejectedValue(new Error('db down'));
            const reserve = jest.fn().mockResolvedValue(undefined);
            const result = await makeGate().admit({ userId: 'user-1', workId: 'work-1' }, reserve);
            expect(result).toEqual({ admitted: false, queuedReason: QUEUED_REASON_KILL_SWITCH });
            expect(reserve).toHaveBeenCalledTimes(1);
            expect(reserve).toHaveBeenCalledWith({
                admitted: false,
                queuedReason: QUEUED_REASON_KILL_SWITCH,
            });
        });
    });

    describe('drainForWork(workId, "kill-switch")', () => {
        // Pinned on BOTH sides: `apps/api`'s `FleetKillSwitchActiveError`
        // sets this exact `name` (its routing spec asserts the literal), and
        // the gate re-parks on it. Two packages, one literal, two pins.
        it('recognises the api-side error by the pinned Error.name', () => {
            expect(KILL_SWITCH_ACTIVE_ERROR_NAME).toBe('FleetKillSwitchActiveError');
        });

        it('promotes a kill-switch-parked run through the same claim + enqueue path', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            const result = await makeGate().drainForWork('work-1', QUEUED_REASON_KILL_SWITCH);

            expect(runs.findOldestQueuedForConcurrency).toHaveBeenCalledWith(
                'work-1',
                QUEUED_REASON_KILL_SWITCH,
            );
            expect(runs.claimQueuedForDispatch).toHaveBeenCalledWith(
                'run-parked',
                QUEUED_REASON_KILL_SWITCH,
            );
            expect(dispatcher.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({ runId: 'run-parked', taskId: 'task-1' }),
            );
            expect(runs.setTriggerRunId).toHaveBeenCalledWith('run-parked', 'trd-1');
            expect(result).toEqual({ dispatched: true, runId: 'run-parked' });
            expect(runs.relabelQueuedReason).not.toHaveBeenCalled();
        });

        it('leaves the run parked (no relabel) while the flag is STILL set', async () => {
            killSwitch.shouldHaltDispatch.mockResolvedValue(true);
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            const result = await makeGate().drainForWork('work-1', QUEUED_REASON_KILL_SWITCH);
            expect(result).toEqual({ dispatched: false, reason: 'over-limit' });
            expect(runs.claimQueuedForDispatch).not.toHaveBeenCalled();
            expect(runs.relabelQueuedReason).not.toHaveBeenCalled();
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        });

        it('relabels to `concurrency-limit` when the flag is clear but the Work is saturated', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            runs.countInFlightForWork.mockResolvedValueOnce(10); // default limit 10
            const result = await makeGate().drainForWork('work-1', QUEUED_REASON_KILL_SWITCH);
            expect(result).toEqual({ dispatched: false, reason: 'over-limit' });
            expect(runs.relabelQueuedReason).toHaveBeenCalledWith(
                'run-parked',
                QUEUED_REASON_KILL_SWITCH,
                QUEUED_REASON_CONCURRENCY,
            );
            expect(runs.claimQueuedForDispatch).not.toHaveBeenCalled();
        });

        it('the default reason is still `concurrency-limit` and never relabels', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(
                parkedRun({ queuedReason: QUEUED_REASON_CONCURRENCY }),
            );
            runs.countInFlightForWork.mockResolvedValueOnce(10);
            const result = await makeGate().drainForWork('work-1');
            expect(runs.findOldestQueuedForConcurrency).toHaveBeenCalledWith(
                'work-1',
                QUEUED_REASON_CONCURRENCY,
            );
            expect(result).toEqual({ dispatched: false, reason: 'over-limit' });
            expect(runs.relabelQueuedReason).not.toHaveBeenCalled();
        });

        /**
         * Clear → promote → re-stop: admission passed (flag clear), then
         * the dispatcher read the flag again and refused. A stop must PARK
         * work, never fail it — the run goes back to `kill-switch` so the
         * next clear resumes it, and nothing is stamped.
         */
        it('re-parks (never fails) a promoted run the dispatcher refuses on the stop flag', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            const refused = new Error('Dispatch refused: the global stop flag is set');
            refused.name = KILL_SWITCH_ACTIVE_ERROR_NAME;
            dispatcher.enqueue.mockRejectedValueOnce(refused);

            const result = await makeGate().drainForWork('work-1', QUEUED_REASON_KILL_SWITCH);

            expect(result).toEqual({ dispatched: false, reason: 'over-limit' });
            expect(runs.restoreQueuedReason).toHaveBeenCalledWith(
                'run-parked',
                QUEUED_REASON_KILL_SWITCH,
            );
            expect(runs.markDispatchFailed).not.toHaveBeenCalled();
            expect(runs.setTriggerRunId).not.toHaveBeenCalled();
        });

        it('re-parks a CONCURRENCY-drained run too when the dispatcher refuses on the stop flag', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(
                parkedRun({ queuedReason: QUEUED_REASON_CONCURRENCY }),
            );
            const refused = new Error('Dispatch refused: the global stop flag is set');
            refused.name = KILL_SWITCH_ACTIVE_ERROR_NAME;
            dispatcher.enqueue.mockRejectedValueOnce(refused);

            const result = await makeGate().drainForWork('work-1');

            expect(result).toEqual({ dispatched: false, reason: 'over-limit' });
            // Parked under the reason that actually holds it now.
            expect(runs.restoreQueuedReason).toHaveBeenCalledWith(
                'run-parked',
                QUEUED_REASON_KILL_SWITCH,
            );
            expect(runs.markDispatchFailed).not.toHaveBeenCalled();
        });

        it('still fails a promoted run whose enqueue throws for any OTHER reason', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            dispatcher.enqueue.mockRejectedValueOnce(new Error('runtime down'));

            const result = await makeGate().drainForWork('work-1', QUEUED_REASON_KILL_SWITCH);

            expect(result).toEqual({ dispatched: false, reason: 'dispatch-failed' });
            expect(runs.markDispatchFailed).toHaveBeenCalledWith(
                'run-parked',
                expect.stringContaining('runtime down'),
            );
            expect(runs.restoreQueuedReason).not.toHaveBeenCalled();
        });

        it('a concurrency drain does NOT promote while the flag is set', async () => {
            killSwitch.shouldHaltDispatch.mockResolvedValue(true);
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(
                parkedRun({ queuedReason: QUEUED_REASON_CONCURRENCY }),
            );
            const result = await makeGate().drainForWork('work-1');
            expect(result).toEqual({ dispatched: false, reason: 'over-limit' });
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        });
    });

    describe('promoteParked', () => {
        const seed = (perWork: Record<string, string[]>) => {
            const remaining: Record<string, string[]> = Object.fromEntries(
                Object.entries(perWork).map(([workId, ids]) => [workId, [...ids]]),
            );
            runs.findQueuedWorkIdsByReason.mockResolvedValue(Object.keys(perWork));
            runs.findOldestQueuedForConcurrency.mockImplementation(async (workId: string) => {
                const next = remaining[workId]?.shift();
                return next ? parkedRun({ id: next, workId }) : null;
            });
        };

        it('promotes every parked run across every Work, oldest first per Work', async () => {
            seed({ 'work-a': ['a-1', 'a-2'], 'work-b': ['b-1'] });
            const result = await makeGate().promoteParked(QUEUED_REASON_KILL_SWITCH, 10);
            expect(result).toEqual({ promoted: 3, works: 2, budgetExhausted: false });
            expect(runs.findQueuedWorkIdsByReason).toHaveBeenCalledWith(
                QUEUED_REASON_KILL_SWITCH,
                10,
            );
            expect(
                dispatcher.enqueue.mock.calls.map(([p]: [{ runId: string }]) => p.runId),
            ).toEqual(['a-1', 'a-2', 'b-1']);
        });

        it('stops at the promotion budget and says so', async () => {
            seed({ 'work-a': ['a-1', 'a-2'], 'work-b': ['b-1'] });
            const result = await makeGate().promoteParked(QUEUED_REASON_KILL_SWITCH, 2);
            expect(result).toEqual({ promoted: 2, works: 2, budgetExhausted: true });
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
        });

        it('moves on to the next Work when one refuses (saturated)', async () => {
            seed({ 'work-a': ['a-1'], 'work-b': ['b-1'] });
            runs.countInFlightForWork.mockImplementation(async (workId: string) =>
                workId === 'work-a' ? 10 : 0,
            );
            const result = await makeGate().promoteParked(QUEUED_REASON_KILL_SWITCH, 10);
            expect(result).toEqual({ promoted: 1, works: 2, budgetExhausted: false });
            expect(runs.relabelQueuedReason).toHaveBeenCalledWith(
                'a-1',
                QUEUED_REASON_KILL_SWITCH,
                QUEUED_REASON_CONCURRENCY,
            );
        });

        it('never throws — a failing Work lookup reports zero promotions', async () => {
            runs.findQueuedWorkIdsByReason.mockRejectedValue(new Error('db down'));
            await expect(makeGate().promoteParked(QUEUED_REASON_KILL_SWITCH, 10)).resolves.toEqual({
                promoted: 0,
                works: 0,
                budgetExhausted: false,
            });
        });

        it('a zero budget is a no-op that touches nothing', async () => {
            const result = await makeGate().promoteParked(QUEUED_REASON_KILL_SWITCH, 0);
            expect(result).toEqual({ promoted: 0, works: 0, budgetExhausted: false });
            expect(runs.findQueuedWorkIdsByReason).not.toHaveBeenCalled();
        });
    });
});

describe('AgentRunSweeperService — kill-switch-parked runs are never reaped (EW-778)', () => {
    const ENV_KEYS = [
        'AGENT_RUN_SWEEPER_ENABLED',
        'AGENT_RUN_STUCK_SWEEP_MINUTES',
        'AGENT_RUN_STUCK_SWEEP_BATCH',
        'AGENT_RUN_STALE_PARK_ENABLED',
    ];
    const saved: Record<string, string | undefined> = {};
    let runs: any;

    const row = (over: Record<string, unknown> = {}) => ({
        id: 'r1',
        agentId: 'a1',
        triggerKind: 'task',
        status: 'queued',
        startedAt: null,
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
        workId: 'work-1',
        awaitingInput: false,
        queuedReason: null,
        ...over,
    });

    const makeSvc = () => {
        const svc = new AgentRunSweeperService(runs);
        for (const level of ['warn', 'log'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    };

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
        runs = {
            findStuckNonTerminal: jest.fn().mockResolvedValue([]),
            markStuckFailed: jest.fn().mockResolvedValue(0),
            parkStaleRunning: jest.fn().mockResolvedValue(0),
            findQueuedTooLong: jest.fn().mockResolvedValue([]),
            setAttention: jest.fn().mockResolvedValue(true),
            findById: jest.fn().mockResolvedValue(null),
        };
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('asks the repository to exempt kill-switch-parked rows in the SQL', async () => {
        await makeSvc().sweepStuckRuns();
        expect(runs.findStuckNonTerminal).toHaveBeenCalledWith(
            expect.any(Date),
            expect.any(Number),
            [QUEUED_REASON_KILL_SWITCH],
        );
    });

    it('re-asserts the exemption in the service: a parked row handed back is not reaped', async () => {
        runs.findStuckNonTerminal.mockResolvedValue([
            row({ id: 'parked', queuedReason: QUEUED_REASON_KILL_SWITCH }),
        ]);
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.swept).toBe(0);
        expect(summary.scanned).toBe(0);
        expect(runs.markStuckFailed).not.toHaveBeenCalled();
    });

    it('still reaps a genuinely stuck queued row in the same batch', async () => {
        runs.findStuckNonTerminal.mockResolvedValue([
            row({ id: 'parked', queuedReason: QUEUED_REASON_KILL_SWITCH }),
            row({ id: 'dead', queuedReason: null }),
        ]);
        runs.markStuckFailed.mockResolvedValue(1);
        const summary = await makeSvc().sweepStuckRuns();
        expect(summary.swept).toBe(1);
        expect(runs.markStuckFailed).toHaveBeenCalledWith(['dead'], expect.any(String));
    });
});
