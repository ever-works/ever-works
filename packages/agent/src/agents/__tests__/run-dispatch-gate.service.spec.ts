import { QUEUED_REASON_CONCURRENCY, RunDispatchGateService } from '../run-dispatch-gate.service';

/**
 * Run orchestration (Wave 4 M2) — dispatch-gate contract:
 * admit under/over the per-Work and per-org/user valves, valve
 * disabling, per-Work counter isolation, and the drain path
 * (oldest-first promotion, CAS claim, dispatch failure posture).
 */
describe('RunDispatchGateService', () => {
    const ENV_KEYS = [
        'AGENT_MAX_CONCURRENT_RUNS_PER_WORK',
        'AGENT_MAX_CONCURRENT_RUNS_PER_ORG',
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};

    let runs: any;
    let dispatcher: any;

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
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    const makeGate = (withDispatcher = true) =>
        new RunDispatchGateService(runs, withDispatcher ? dispatcher : undefined);

    const parkedRun = (over: Record<string, unknown> = {}) => ({
        id: 'run-parked',
        agentId: 'agent-1',
        userId: 'user-1',
        taskId: 'task-1',
        workId: 'work-1',
        organizationId: null,
        status: 'queued',
        queuedReason: QUEUED_REASON_CONCURRENCY,
        ...over,
    });

    describe('admit', () => {
        it('admits under the per-Work limit', async () => {
            runs.countInFlightForWork.mockResolvedValueOnce(9); // default limit 10
            const result = await makeGate().admit({ userId: 'user-1', workId: 'work-1' });
            expect(result).toEqual({ admitted: true });
            expect(runs.countInFlightForWork).toHaveBeenCalledWith('work-1');
        });

        it('queues at/over the per-Work limit with the concurrency reason', async () => {
            runs.countInFlightForWork.mockResolvedValueOnce(10); // default limit 10
            const result = await makeGate().admit({ userId: 'user-1', workId: 'work-1' });
            expect(result).toEqual({
                admitted: false,
                queuedReason: QUEUED_REASON_CONCURRENCY,
            });
        });

        it('honours the env-configured per-Work valve (configurable, not hardcoded)', async () => {
            process.env.AGENT_MAX_CONCURRENT_RUNS_PER_WORK = '2';
            runs.countInFlightForWork.mockResolvedValueOnce(2);
            const result = await makeGate().admit({ userId: 'user-1', workId: 'work-1' });
            expect(result.admitted).toBe(false);
        });

        it('a per-Work valve of 0 disables the Work limit entirely', async () => {
            process.env.AGENT_MAX_CONCURRENT_RUNS_PER_WORK = '0';
            const result = await makeGate().admit({ userId: 'user-1', workId: 'work-1' });
            expect(result.admitted).toBe(true);
            expect(runs.countInFlightForWork).not.toHaveBeenCalled();
        });

        it('counts per-org when an organizationId is present, per-user otherwise', async () => {
            const gate = makeGate();
            await gate.admit({ userId: 'user-1', workId: null, organizationId: 'org-1' });
            expect(runs.countInFlightForOrganization).toHaveBeenCalledWith('org-1');
            expect(runs.countInFlightForUser).not.toHaveBeenCalled();

            await gate.admit({ userId: 'user-1', workId: null });
            expect(runs.countInFlightForUser).toHaveBeenCalledWith('user-1');
        });

        it('queues over the org/user valve even when the Work has capacity', async () => {
            runs.countInFlightForWork.mockResolvedValueOnce(1);
            runs.countInFlightForUser.mockResolvedValueOnce(25); // default org valve 25
            const result = await makeGate().admit({ userId: 'user-1', workId: 'work-1' });
            expect(result).toEqual({
                admitted: false,
                queuedReason: QUEUED_REASON_CONCURRENCY,
            });
        });

        it('isolates counters per Work — a saturated Work A never blocks Work B', async () => {
            const counts: Record<string, number> = { 'work-a': 10, 'work-b': 0 };
            runs.countInFlightForWork.mockImplementation(async (workId: string) => {
                return counts[workId] ?? 0;
            });
            const gate = makeGate();
            const a = await gate.admit({ userId: 'user-1', workId: 'work-a' });
            const b = await gate.admit({ userId: 'user-1', workId: 'work-b' });
            expect(a.admitted).toBe(false);
            expect(b.admitted).toBe(true);
            expect(runs.countInFlightForWork).toHaveBeenCalledWith('work-a');
            expect(runs.countInFlightForWork).toHaveBeenCalledWith('work-b');
        });

        it('skips the Work valve for Work-less runs but still applies the user valve', async () => {
            runs.countInFlightForUser.mockResolvedValueOnce(0);
            const result = await makeGate().admit({ userId: 'user-1' });
            expect(result.admitted).toBe(true);
            expect(runs.countInFlightForWork).not.toHaveBeenCalled();
            expect(runs.countInFlightForUser).toHaveBeenCalledWith('user-1');
        });
    });

    describe('drainForWork', () => {
        it('promotes the oldest parked run: claims it and dispatches with its runId', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            const result = await makeGate().drainForWork('work-1');
            expect(runs.findOldestQueuedForConcurrency).toHaveBeenCalledWith(
                'work-1',
                QUEUED_REASON_CONCURRENCY,
            );
            expect(runs.claimQueuedForDispatch).toHaveBeenCalledWith(
                'run-parked',
                QUEUED_REASON_CONCURRENCY,
            );
            expect(dispatcher.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({
                    agentId: 'agent-1',
                    userId: 'user-1',
                    taskId: 'task-1',
                    runId: 'run-parked',
                }),
            );
            expect(runs.setTriggerRunId).toHaveBeenCalledWith('run-parked', 'trd-1');
            expect(result).toEqual({ dispatched: true, runId: 'run-parked' });
        });

        it('no-ops when no parked run exists for the Work', async () => {
            const result = await makeGate().drainForWork('work-1');
            expect(result).toEqual({ dispatched: false, reason: 'no-candidate' });
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        });

        it('leaves the run parked while the Work is still over its limit', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            runs.countInFlightForWork.mockResolvedValueOnce(10);
            const result = await makeGate().drainForWork('work-1');
            expect(result).toEqual({ dispatched: false, reason: 'over-limit' });
            expect(runs.claimQueuedForDispatch).not.toHaveBeenCalled();
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        });

        it('does not double-dispatch when another drain wins the CAS claim', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            runs.claimQueuedForDispatch.mockResolvedValueOnce(false);
            const result = await makeGate().drainForWork('work-1');
            expect(result).toEqual({ dispatched: false, reason: 'claim-lost' });
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
        });

        it('reports no-dispatcher without claiming when the dispatcher is unbound', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            const result = await makeGate(false).drainForWork('work-1');
            expect(result).toEqual({ dispatched: false, reason: 'no-dispatcher' });
            // The row was never claimed, so it stays parked and drainable.
            expect(runs.claimQueuedForDispatch).not.toHaveBeenCalled();
        });

        it('marks the drained run dispatch-failed when the enqueue throws', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            dispatcher.enqueue.mockRejectedValueOnce(new Error('Trigger.dev down'));
            const result = await makeGate().drainForWork('work-1');
            expect(result).toEqual({ dispatched: false, reason: 'dispatch-failed' });
            expect(runs.markDispatchFailed).toHaveBeenCalledWith(
                'run-parked',
                expect.stringContaining('dispatch-failed: Trigger.dev down'),
            );
        });

        it('never throws — a repository failure is reported, not raised', async () => {
            runs.findOldestQueuedForConcurrency.mockRejectedValueOnce(new Error('DB down'));
            await expect(makeGate().drainForWork('work-1')).resolves.toEqual({
                dispatched: false,
                reason: 'dispatch-failed',
            });
        });

        it('uses a run-scoped dedup key so a double drain dedups at the runner', async () => {
            runs.findOldestQueuedForConcurrency.mockResolvedValueOnce(parkedRun());
            await makeGate().drainForWork('work-1');
            expect(dispatcher.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({ dedupKey: 'task-1:agent-1:drain:run-parked' }),
            );
        });
    });
});
