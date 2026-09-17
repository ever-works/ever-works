import {
    QUEUED_REASON_AGENT_PAUSED,
    QUEUED_REASON_CONCURRENCY,
    RunDispatchGateService,
} from '../run-dispatch-gate.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * AW-23 — the dispatch gate with the `RUN_AGENT_BRAKE` port bound, and
 * the release that makes a pause reversible.
 *
 * Two halves:
 *
 *   - `admit()` parks every new run for a paused agent with
 *     `agent-paused` — including through the critical-section wrapper
 *     that FAILS OPEN on a throwing chain, which is exactly the seam a
 *     fail-closed brake has to survive;
 *   - `promoteParkedForAgent()` releases held work oldest-first through
 *     the SAME claim-CAS / dispatch / stamp path a concurrency drain
 *     uses, bounded, and reports how many actually went out.
 */
describe('RunDispatchGateService — the agent brake (AW-23)', () => {
    const ENV_KEYS = [
        'AGENT_MAX_CONCURRENT_RUNS_PER_WORK',
        'AGENT_MAX_CONCURRENT_RUNS_PER_ORG',
        'CREDITS_ENFORCEMENT',
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};

    let runs: any;
    let dispatcher: any;
    let agentBrake: { shouldHaltForAgent: jest.Mock };

    const heldRun = (over: Record<string, unknown> = {}) => ({
        id: 'run-held',
        agentId: 'agent-1',
        userId: 'user-1',
        taskId: 'task-1',
        workId: 'work-1',
        organizationId: null,
        tenantId: null,
        triggerKind: 'task',
        chatMessageId: null,
        status: 'queued',
        queuedReason: QUEUED_REASON_AGENT_PAUSED,
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
            findOldestQueuedForAgent: jest.fn().mockResolvedValue(null),
            claimQueuedForDispatch: jest.fn().mockResolvedValue(true),
            restoreQueuedReason: jest.fn().mockResolvedValue(undefined),
            relabelQueuedReason: jest.fn().mockResolvedValue(true),
            findQueuedWorkIdsByReason: jest.fn().mockResolvedValue([]),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        agentBrake = { shouldHaltForAgent: jest.fn().mockResolvedValue({ halted: false }) };
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    // The brake is the SEVENTH positional argument (appended LAST).
    const makeGate = () =>
        new RunDispatchGateService(
            runs,
            dispatcher,
            undefined,
            undefined,
            undefined,
            undefined,
            agentBrake as never,
        );

    describe('admit', () => {
        it('parks a new run for a paused agent with `agent-paused`', async () => {
            agentBrake.shouldHaltForAgent.mockResolvedValue({ halted: true, reason: 'user' });
            const result = await makeGate().admit({
                userId: 'user-1',
                workId: 'work-1',
                agentId: 'agent-1',
            });
            expect(result).toEqual({ admitted: false, queuedReason: QUEUED_REASON_AGENT_PAUSED });
            // The brake sits before the valves, so no counting happened.
            expect(runs.countInFlightForWork).not.toHaveBeenCalled();
        });

        it('admits as before for an active agent', async () => {
            const result = await makeGate().admit({
                userId: 'user-1',
                workId: 'work-1',
                agentId: 'agent-1',
            });
            expect(result).toEqual({ admitted: true });
            expect(agentBrake.shouldHaltForAgent).toHaveBeenCalledWith('agent-1');
        });

        it('leaves a caller that passes no agentId byte-for-byte unchanged', async () => {
            const result = await makeGate().admit({ userId: 'user-1', workId: 'work-1' });
            expect(result).toEqual({ admitted: true });
            expect(agentBrake.shouldHaltForAgent).not.toHaveBeenCalled();
        });

        it('reserves a HELD row when the brake throws, through the fail-open wrapper', async () => {
            // The critical-section path fails OPEN on a throwing chain, so
            // a throwing brake must still reach `reserve` as a PARK
            // verdict — otherwise a pause lets work through at exactly the
            // moment it matters most.
            agentBrake.shouldHaltForAgent.mockRejectedValue(new Error('db down'));
            const reserve = jest.fn().mockResolvedValue(undefined);
            const result = await makeGate().admit(
                { userId: 'user-1', workId: 'work-1', agentId: 'agent-1' },
                reserve,
            );
            expect(result).toEqual({ admitted: false, queuedReason: QUEUED_REASON_AGENT_PAUSED });
            expect(reserve).toHaveBeenCalledWith({
                admitted: false,
                queuedReason: QUEUED_REASON_AGENT_PAUSED,
            });
        });
    });

    describe('promoteParkedForAgent', () => {
        it('releases held runs oldest-first and reports the count', async () => {
            const first = heldRun({ id: 'held-1' });
            const second = heldRun({ id: 'held-2', taskId: 'task-2' });
            runs.findOldestQueuedForAgent
                .mockResolvedValueOnce(first)
                .mockResolvedValueOnce(second)
                .mockResolvedValue(null);

            const result = await makeGate().promoteParkedForAgent('agent-1');

            expect(result.promoted).toBe(2);
            expect(result.budgetExhausted).toBe(false);
            expect(runs.claimQueuedForDispatch).toHaveBeenNthCalledWith(
                1,
                'held-1',
                QUEUED_REASON_AGENT_PAUSED,
            );
            expect(runs.claimQueuedForDispatch).toHaveBeenNthCalledWith(
                2,
                'held-2',
                QUEUED_REASON_AGENT_PAUSED,
            );
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
        });

        it('reports zero when nothing is held', async () => {
            const result = await makeGate().promoteParkedForAgent('agent-1');
            expect(result).toEqual({ promoted: 0, works: 0, budgetExhausted: false });
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        });

        it('stops at the promotion budget and says so', async () => {
            runs.findOldestQueuedForAgent.mockResolvedValue(heldRun());
            const result = await makeGate().promoteParkedForAgent('agent-1', 2);
            expect(result.promoted).toBe(2);
            expect(result.budgetExhausted).toBe(true);
        });

        it('a zero budget is a no-op that touches nothing', async () => {
            const result = await makeGate().promoteParkedForAgent('agent-1', 0);
            expect(result).toEqual({ promoted: 0, works: 0, budgetExhausted: false });
            expect(runs.findOldestQueuedForAgent).not.toHaveBeenCalled();
        });

        it('re-parks a held run whose agent was paused again mid-drain', async () => {
            // The re-admission passes the candidate's agentId, so a
            // re-pause between Resume and the drain refuses the run again
            // rather than letting it slip out.
            runs.findOldestQueuedForAgent.mockResolvedValue(heldRun());
            agentBrake.shouldHaltForAgent.mockResolvedValue({ halted: true });
            const result = await makeGate().promoteParkedForAgent('agent-1');
            expect(result.promoted).toBe(0);
            expect(runs.claimQueuedForDispatch).not.toHaveBeenCalled();
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        });

        it('hands a run the Work valve now refuses to the reason that WILL drain it', async () => {
            // Otherwise the run stays parked as `agent-paused` on an agent
            // that is no longer paused — a label nothing is looking for.
            runs.findOldestQueuedForAgent.mockResolvedValue(heldRun());
            runs.countInFlightForWork.mockResolvedValue(10);
            const result = await makeGate().promoteParkedForAgent('agent-1');
            expect(result.promoted).toBe(0);
            expect(runs.relabelQueuedReason).toHaveBeenCalledWith(
                'run-held',
                QUEUED_REASON_AGENT_PAUSED,
                QUEUED_REASON_CONCURRENCY,
            );
        });

        it('never throws — a resume must succeed even when the drain breaks', async () => {
            runs.findOldestQueuedForAgent.mockRejectedValue(new Error('db down'));
            await expect(makeGate().promoteParkedForAgent('agent-1')).resolves.toEqual({
                promoted: 0,
                works: 0,
                budgetExhausted: false,
            });
        });

        it('degrades to a no-op against a repository without the query', async () => {
            delete runs.findOldestQueuedForAgent;
            await expect(makeGate().promoteParkedForAgent('agent-1')).resolves.toEqual({
                promoted: 0,
                works: 0,
                budgetExhausted: false,
            });
        });
    });
});
