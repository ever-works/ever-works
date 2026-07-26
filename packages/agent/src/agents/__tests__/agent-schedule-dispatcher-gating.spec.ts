import { AgentScheduleDispatcherService } from '../agent-schedule-dispatcher.service';
import { AgentStatus } from '../../entities/agent.entity';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Run orchestration — the heartbeat cron and "Run now" are dispatch
 * paths too, and they used to walk straight past the concurrency valve
 * that every Task-keyed path respects.
 *
 * They DEFER rather than park. `RunDispatchGateService.drainForWork`
 * promotes concurrency-parked rows through the Task-keyed dispatchers,
 * and a heartbeat run has no Task — a parked one would sit `queued`
 * forever with nothing able to drain it (the drain says exactly that:
 * "parked run has no taskId — cannot drain"). Deferring is self-healing
 * instead: the cron re-offers the Agent next tick, and run-now returns a
 * `skipped` reason the caller can retry on.
 */
describe('AgentScheduleDispatcherService — heartbeat dispatch is gated', () => {
    const ENV_KEYS = ['AGENTS_DISPATCHER_ENABLED'] as const;
    const savedEnv: Record<string, string | undefined> = {};

    let agentRepository: any;
    let agentRunRepository: any;
    let trigger: any;

    const agent = (over: Record<string, unknown> = {}) => ({
        id: 'agent-1',
        userId: 'user-1',
        organizationId: 'org-1',
        scope: 'global',
        status: AgentStatus.ACTIVE,
        heartbeatCadence: 'manual',
        nextHeartbeatAt: new Date('2026-01-01'),
        ...over,
    });

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        agentRepository = {
            findDueForHeartbeat: jest.fn().mockResolvedValue([agent()]),
            findStuckRunning: jest.fn().mockResolvedValue([]),
            findById: jest.fn().mockResolvedValue(agent()),
            tryClaimForRun: jest.fn().mockResolvedValue(new Date('2026-01-02')),
            tryClaimForManualRun: jest
                .fn()
                .mockResolvedValue({ priorNextHeartbeatAt: new Date('2026-01-02') }),
            releaseAfterRun: jest.fn().mockResolvedValue(undefined),
            releaseAfterManualRunFailure: jest.fn().mockResolvedValue(undefined),
            updateById: jest.fn().mockResolvedValue(undefined),
        };
        agentRunRepository = {
            createQueued: jest.fn().mockResolvedValue({ id: 'run-hb-1' }),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        };
        trigger = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    const makeSvc = (dispatchGate?: any) =>
        new AgentScheduleDispatcherService(agentRepository, agentRunRepository, dispatchGate);

    const gateAdmitting = (admitted: boolean) => ({
        admit: jest
            .fn()
            .mockResolvedValue(
                admitted
                    ? { admitted: true }
                    : { admitted: false, queuedReason: 'concurrency-limit' },
            ),
    });

    describe('dispatchDue (cron)', () => {
        it('consults the gate on the org/user scope (heartbeats are not Work-scoped)', async () => {
            const gate = gateAdmitting(true);
            await makeSvc(gate).dispatchDue(trigger);
            expect(gate.admit).toHaveBeenCalledWith({
                userId: 'user-1',
                workId: null,
                organizationId: 'org-1',
            });
        });

        it('dispatches normally when admitted', async () => {
            const summary = await makeSvc(gateAdmitting(true)).dispatchDue(trigger);
            expect(summary.dispatched).toBe(1);
            expect(trigger.enqueue).toHaveBeenCalledTimes(1);
        });

        it('DEFERS over the valve: no claim, no run row, no enqueue', async () => {
            const summary = await makeSvc(gateAdmitting(false)).dispatchDue(trigger);
            expect(summary.dispatched).toBe(0);
            expect(summary.skipped).toBe(1);
            expect(summary.entries[0]).toEqual(
                expect.objectContaining({ outcome: 'skipped', message: 'concurrency-limit' }),
            );
            // Nothing to unwind — the Agent keeps its schedule and comes
            // back on the next tick.
            expect(agentRepository.tryClaimForRun).not.toHaveBeenCalled();
            expect(agentRunRepository.createQueued).not.toHaveBeenCalled();
            expect(trigger.enqueue).not.toHaveBeenCalled();
            expect(agentRepository.releaseAfterRun).not.toHaveBeenCalled();
        });

        it('never PARKS a heartbeat run (nothing could ever drain it)', async () => {
            await makeSvc(gateAdmitting(false)).dispatchDue(trigger);
            expect(agentRunRepository.createQueued).not.toHaveBeenCalled();
        });

        it('FAILS OPEN when the gate throws — a broken valve must not stop the sweep', async () => {
            const gate = { admit: jest.fn().mockRejectedValue(new Error('gate exploded')) };
            const summary = await makeSvc(gate).dispatchDue(trigger);
            expect(summary.dispatched).toBe(1);
            expect(trigger.enqueue).toHaveBeenCalledTimes(1);
        });

        it('behaves exactly as before when no gate is bound', async () => {
            const summary = await makeSvc(undefined).dispatchDue(trigger);
            expect(summary.dispatched).toBe(1);
        });

        it('defers only the saturated Agent — the rest of the batch still goes', async () => {
            agentRepository.findDueForHeartbeat.mockResolvedValueOnce([
                agent({ id: 'agent-hot', userId: 'user-hot' }),
                agent({ id: 'agent-cold', userId: 'user-cold' }),
            ]);
            const gate = {
                admit: jest.fn(async (input: { userId: string }) => ({
                    admitted: input.userId !== 'user-hot',
                })),
            };
            const summary = await makeSvc(gate).dispatchDue(trigger);
            expect(summary.dispatched).toBe(1);
            expect(summary.skipped).toBe(1);
            expect(trigger.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({ agentId: 'agent-cold' }),
            );
        });
    });

    describe('dispatchOne (run-now)', () => {
        it('dispatches when admitted', async () => {
            const result = await makeSvc(gateAdmitting(true)).dispatchOne(trigger, 'agent-1');
            expect(result).toEqual({ outcome: 'dispatched', runId: 'run-hb-1' });
        });

        it('reports a retryable `concurrency-limit` skip over the valve', async () => {
            const result = await makeSvc(gateAdmitting(false)).dispatchOne(trigger, 'agent-1');
            expect(result).toEqual({ outcome: 'skipped', reason: 'concurrency-limit' });
            // Checked before the CAS claim ⇒ nothing to unwind.
            expect(agentRepository.tryClaimForManualRun).not.toHaveBeenCalled();
            expect(agentRunRepository.createQueued).not.toHaveBeenCalled();
            expect(trigger.enqueue).not.toHaveBeenCalled();
        });

        it('checks ownership/status BEFORE the valve (a missing Agent is still a 404)', async () => {
            agentRepository.findById.mockResolvedValueOnce(null);
            const gate = gateAdmitting(false);
            const result = await makeSvc(gate).dispatchOne(trigger, 'nope');
            expect(result).toEqual({ outcome: 'skipped', reason: 'agent-missing' });
            expect(gate.admit).not.toHaveBeenCalled();
        });

        it('FAILS OPEN when the gate throws', async () => {
            const gate = { admit: jest.fn().mockRejectedValue(new Error('gate exploded')) };
            const result = await makeSvc(gate).dispatchOne(trigger, 'agent-1');
            expect(result).toEqual({ outcome: 'dispatched', runId: 'run-hb-1' });
        });

        it('behaves exactly as before when no gate is bound', async () => {
            const result = await makeSvc(undefined).dispatchOne(trigger, 'agent-1');
            expect(result).toEqual({ outcome: 'dispatched', runId: 'run-hb-1' });
        });
    });
});
