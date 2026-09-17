// Short-circuit the transitive `@ever-works/agent/*` import chain so the
// test doesn't pull `@src/entities` (which only resolves inside apps/api)
// through `packages/agent/src/database/repositories/...`. Mirrors the
// pattern `agents.controller.runtime.spec.ts` uses.
jest.mock('@ever-works/agent/agents', () => ({
    __esModule: true,
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
    AGENT_RUN_CANCELLER: 'AGENT_RUN_CANCELLER',
    AGENT_FILE_NAMES: ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'],
    AgentScope: { TENANT: 'tenant', MISSION: 'mission', IDEA: 'idea', WORK: 'work' },
    AgentStatus: {
        DRAFT: 'draft',
        ACTIVE: 'active',
        RUNNING: 'running',
        PAUSED: 'paused',
        ERROR: 'error',
        ARCHIVED: 'archived',
    },
    AgentHaltReason: {
        USER: 'user',
        CREDENTIAL: 'credential',
        FAILURES: 'failures',
        CAP: 'cap',
        PLATFORM: 'platform',
    },
    QUEUED_REASON_AGENT_PAUSED: 'agent-paused',
    AgentIdleBehavior: { PROPOSE: 'propose', NOOP: 'noop', OBSERVE: 'observe' },
    AgentAvatarMode: { INITIALS: 'initials', ICON: 'icon', IMAGE: 'image' },
    AGENT_PERMISSIONS_DEFAULT: {},
    AgentsService: class {},
    AgentFileService: class {},
    AgentExportService: class {},
    AgentHaltService: class {},
    AgentScheduleDispatcherService: class {},
    AgentRunRepository: class {},
    AgentRunLogRepository: class {},
    RunDispatchGateService: class {},
    RunSteeringService: class {},
    SkillBindingRepository: class {},
    PluginUsageRepository: class {},
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    __esModule: true,
    AGENT_TASK_EXECUTE_DISPATCHER: 'AGENT_TASK_EXECUTE_DISPATCHER',
    TasksService: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    __esModule: true,
    ActivityActionType: {
        AGENT_PAUSED: 'agent_paused',
        AGENT_RESUMED: 'agent_resumed',
        AGENT_UNARCHIVED: 'agent_unarchived',
        AGENT_RUN_TRIGGERED: 'agent_run_triggered',
        AGENT_RUN_CANCELLED: 'agent_run_cancelled',
        AGENT_TASK_ASSIGNED: 'agent_task_assigned',
        AGENT_RUN_HELD: 'agent_run_held',
        AGENT_RUNS_RELEASED: 'agent_runs_released',
        AGENT_BLOCKED_ON_CREDENTIAL: 'agent_blocked_on_credential',
        AGENT_CREATED: 'agent_created',
        AGENT_ARCHIVED: 'agent_archived',
        AGENT_EXPORTED: 'agent_exported',
        AGENT_IMPORTED: 'agent_imported',
        AGENT_BUDGET_EXCEEDED: 'agent_budget_exceeded',
        AGENT_COLLABORATOR_ENABLED: 'agent_collaborator_enabled',
        AGENT_COLLABORATOR_DISABLED: 'agent_collaborator_disabled',
        AGENT_COLLABORATOR_REMOVED: 'agent_collaborator_removed',
        AGENT_COMPUTER_CONTROLLED: 'agent_computer_controlled',
    },
    ActivityStatus: { COMPLETED: 'completed' },
}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { AgentsController } from './agents.controller';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * AW-23 — `POST :id/pause` and `POST :id/resume`, the two controls this
 * epic makes honest.
 *
 * The contract these cases defend, in order of importance:
 *
 *  1. **Nothing about the old behaviour changed.** Same path, same verb,
 *     same `AgentDto`. A pause posted with no body at all does exactly
 *     what it did before, field for field.
 *  2. **A second pause does not rewrite the first one's story** — the
 *     note, the time and the author of the FIRST pause survive a stale
 *     tab, and no second activity row is written.
 *  3. **Work that arrives on its own is HELD; work a person asked for
 *     right now is REFUSED** — an assigned task parks, `run-now` 409s
 *     and creates no run row.
 *  4. **A resume releases what was held and says how much.**
 */
describe('AgentsController — pause is a real brake (AW-23)', () => {
    const auth = { userId: 'u1' } as any;
    const agentId = '00000000-0000-0000-0000-000000000001';
    const taskId = '00000000-0000-0000-0000-0000000000bb';

    /** Exactly the `AgentDto` shape the endpoint returned before this epic. */
    const AGENT_DTO = {
        id: agentId,
        userId: 'u1',
        name: 'research-agent',
        slug: 'research-agent',
        title: 'Senior researcher',
        status: 'paused',
        errorCount: 0,
        haltReason: null,
        haltNote: null,
        haltedAt: null,
        haltedRunId: null,
        haltDetail: null,
        haltRepeatCount: 0,
        lastRunAt: null,
        nextHeartbeatAt: null,
        avatarMode: 'initials',
        avatarIcon: null,
    };

    let service: any;
    let agentRuns: any;
    let activityLog: any;
    let halt: any;
    let dispatchGate: any;
    let steering: any;

    const makeController = (over: { halt?: any; dispatchGate?: any; steering?: any } = {}) =>
        new AgentsController(
            service,
            {} as any,
            {} as any,
            { dispatchOne: jest.fn() } as any,
            agentRuns,
            {} as any,
            {} as any,
            {} as any,
            { getOne: jest.fn().mockResolvedValue({ id: taskId }) } as any,
            activityLog,
            { enqueue: jest.fn() } as any,
            { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) } as any,
            undefined,
            'dispatchGate' in over ? over.dispatchGate : dispatchGate,
            undefined,
            'steering' in over ? over.steering : steering,
            undefined,
            'halt' in over ? over.halt : halt,
            undefined,
        );

    beforeEach(() => {
        service = {
            getOne: jest.fn().mockResolvedValue({ ...AGENT_DTO }),
            pause: jest.fn().mockResolvedValue({ ...AGENT_DTO }),
            resume: jest.fn().mockResolvedValue({ ...AGENT_DTO, status: 'active' }),
            unarchive: jest.fn().mockResolvedValue({ ...AGENT_DTO }),
        };
        agentRuns = {
            countInFlightForAgent: jest.fn().mockResolvedValue(0),
            listQueuedForAgent: jest.fn().mockResolvedValue({ total: 0, items: [] }),
            findNewestInFlightForAgent: jest.fn().mockResolvedValue(null),
            findInFlightForTaskAgent: jest.fn().mockResolvedValue(null),
            createQueued: jest.fn().mockResolvedValue({ id: 'run-1' }),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        };
        activityLog = { log: jest.fn().mockResolvedValue(undefined) };
        halt = {
            halt: jest
                .fn()
                .mockResolvedValue({ written: true, repeatCount: 1, transitioned: true }),
            clear: jest.fn().mockResolvedValue(undefined),
        };
        dispatchGate = {
            admit: jest.fn().mockResolvedValue({ admitted: true }),
            promoteParkedForAgent: jest
                .fn()
                .mockResolvedValue({ promoted: 0, works: 0, budgetExhausted: false }),
        };
        steering = { interrupt: jest.fn().mockResolvedValue({ interrupted: true }) };
    });

    describe('POST :id/pause', () => {
        it('an EMPTY body behaves exactly as it did before: the same AgentDto', async () => {
            const result = await makeController().pause(auth, agentId);
            for (const [key, value] of Object.entries(AGENT_DTO)) {
                expect(result[key as keyof typeof result]).toEqual(value);
            }
            expect(service.pause).toHaveBeenCalledWith('u1', agentId, undefined);
        });

        it('records the reason, the author and the note', async () => {
            await makeController().pause(auth, agentId, {
                note: 'holding until the rebrand ships Friday',
            });
            expect(halt.halt).toHaveBeenCalledWith(agentId, 'user', {
                note: 'holding until the rebrand ships Friday',
                byUserId: 'u1',
            });
        });

        it('reports how much is held and how much is still finishing', async () => {
            agentRuns.listQueuedForAgent.mockResolvedValue({ total: 2, items: [] });
            agentRuns.countInFlightForAgent.mockResolvedValue(1);
            const result = await makeController().pause(auth, agentId);
            expect(result.heldCount).toBe(2);
            expect(result.inFlightCount).toBe(1);
        });

        it('REFUSES a note that looks like a secret, and never echoes it back', async () => {
            const leak = 'use sk-ant-api03-AA11bb22CC33dd44EE55ff66GG77hh88II99jj00KK11ll22MM33nn';
            await expect(makeController().pause(auth, agentId, { note: leak })).rejects.toThrow(
                BadRequestException,
            );
            await expect(makeController().pause(auth, agentId, { note: leak })).rejects.not.toThrow(
                new RegExp(leak),
            );
            // Nothing was written: the agent is not even paused.
            expect(service.pause).not.toHaveBeenCalled();
            expect(halt.halt).not.toHaveBeenCalled();
        });

        it('a SECOND pause writes no second activity row', async () => {
            // A stale tab re-posting the pause must not overwrite the
            // first note with an empty one, nor double the trail.
            halt.halt.mockResolvedValue({ written: false, repeatCount: 1, transitioned: false });
            await makeController().pause(auth, agentId);
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('writes ONE activity row carrying whether a note was given, never the note itself', async () => {
            await makeController().pause(auth, agentId, { note: 'holding until Friday' });
            expect(activityLog.log).toHaveBeenCalledTimes(1);
            const logged = activityLog.log.mock.calls[0][0];
            expect(logged.actionType).toBe('agent_paused');
            expect(logged.details).toEqual(
                expect.objectContaining({ hasNote: true, stopInFlight: false }),
            );
            expect(JSON.stringify(logged)).not.toContain('holding until Friday');
        });

        it('leaves a run in flight ALONE unless the caller explicitly asks', async () => {
            agentRuns.findNewestInFlightForAgent.mockResolvedValue({ id: 'run-live' });
            await makeController().pause(auth, agentId);
            expect(steering.interrupt).not.toHaveBeenCalled();
        });

        it('requests the EXISTING cooperative stop when asked to', async () => {
            agentRuns.findNewestInFlightForAgent.mockResolvedValue({ id: 'run-live' });
            await makeController().pause(auth, agentId, { stopInFlight: true });
            expect(steering.interrupt).toHaveBeenCalledWith('run-live', 'u1');
        });

        it('still pauses when the halt record cannot be written', async () => {
            // A missing reason is a degraded label. A failed pause would
            // be a lie, so the transition is what matters.
            const result = await makeController({ halt: undefined }).pause(auth, agentId);
            expect(result.status).toBe('paused');
        });
    });

    describe('POST :id/resume', () => {
        it('clears the stored reason and releases held work, reporting the count', async () => {
            dispatchGate.promoteParkedForAgent.mockResolvedValue({
                promoted: 3,
                works: 0,
                budgetExhausted: false,
            });
            const result = await makeController().resume(auth, agentId);
            expect(halt.clear).toHaveBeenCalledWith(agentId);
            expect(result.releasedCount).toBe(3);
            expect(result.status).toBe('active');
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'agent_resumed',
                    details: expect.objectContaining({ releasedCount: 3 }),
                }),
            );
        });

        it('records the release as its own activity entry', async () => {
            dispatchGate.promoteParkedForAgent.mockResolvedValue({
                promoted: 1,
                works: 0,
                budgetExhausted: false,
            });
            await makeController().resume(auth, agentId);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'agent_runs_released' }),
            );
        });

        it('NEVER fails the resume because the drain broke', async () => {
            dispatchGate.promoteParkedForAgent.mockRejectedValue(new Error('db down'));
            const result = await makeController().resume(auth, agentId);
            expect(result.status).toBe('active');
            expect(result.releasedCount).toBe(0);
        });

        it('reports zero releases with no gate bound', async () => {
            const result = await makeController({ dispatchGate: undefined }).resume(auth, agentId);
            expect(result.releasedCount).toBe(0);
        });
    });

    describe('POST :id/unarchive', () => {
        it('clears the stored reason — a restored agent starts clean', async () => {
            await makeController().unarchive(auth, agentId);
            expect(halt.clear).toHaveBeenCalledWith(agentId);
        });
    });

    describe('POST :id/run-now on a paused agent', () => {
        it('is REFUSED with a 409 and the exact copy, and creates no run row', async () => {
            const dispatcher = { dispatchOne: jest.fn() };
            const controller = new AgentsController(
                service,
                {} as any,
                {} as any,
                dispatcher as any,
                agentRuns,
                {} as any,
                {} as any,
                {} as any,
                {} as any,
                activityLog,
                { enqueue: jest.fn() } as any,
            );
            await expect(controller.runNow(auth, agentId)).rejects.toThrow(ConflictException);
            await expect(controller.runNow(auth, agentId)).rejects.toThrow(
                'This agent is paused. Resume it first.',
            );
            expect(dispatcher.dispatchOne).not.toHaveBeenCalled();
            expect(agentRuns.createQueued).not.toHaveBeenCalled();
        });

        it('still dispatches for an ACTIVE agent', async () => {
            service.getOne.mockResolvedValue({ ...AGENT_DTO, status: 'active' });
            const dispatcher = {
                dispatchOne: jest.fn().mockResolvedValue({ outcome: 'dispatched', runId: 'r1' }),
            };
            const controller = new AgentsController(
                service,
                {} as any,
                {} as any,
                dispatcher as any,
                agentRuns,
                {} as any,
                {} as any,
                {} as any,
                {} as any,
                activityLog,
                { enqueue: jest.fn() } as any,
            );
            await expect(controller.runNow(auth, agentId)).resolves.toEqual({
                outcome: 'dispatched',
                runId: 'r1',
            });
        });
    });

    describe('POST :id/assign-task to a paused agent', () => {
        it('HOLDS the run instead of failing it, and says why', async () => {
            dispatchGate.admit.mockImplementation(
                async (_input: unknown, reserve: (v: unknown) => Promise<void>) => {
                    const verdict = { admitted: false, queuedReason: 'agent-paused' };
                    await reserve(verdict);
                    return verdict;
                },
            );
            const result = await makeController().assignTask(auth, agentId, { taskId });
            expect(result).toEqual({
                runId: 'run-1',
                queued: true,
                queuedReason: 'agent-paused',
            });
            // The row exists, parked — nothing failed.
            expect(agentRuns.createQueued).toHaveBeenCalledWith(
                expect.objectContaining({ queuedReason: 'agent-paused' }),
            );
        });

        it('passes the agent to the gate so the brake can see it', async () => {
            await makeController().assignTask(auth, agentId, { taskId });
            expect(dispatchGate.admit).toHaveBeenCalledWith(
                expect.objectContaining({ agentId }),
                expect.any(Function),
            );
        });

        it('records the hold as its own activity entry, not as a plain assignment', async () => {
            dispatchGate.admit.mockImplementation(
                async (_input: unknown, reserve: (v: unknown) => Promise<void>) => {
                    const verdict = { admitted: false, queuedReason: 'agent-paused' };
                    await reserve(verdict);
                    return verdict;
                },
            );
            await makeController().assignTask(auth, agentId, { taskId });
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'agent_run_held' }),
            );
        });

        it('still records a concurrency park as an ordinary assignment', async () => {
            dispatchGate.admit.mockImplementation(
                async (_input: unknown, reserve: (v: unknown) => Promise<void>) => {
                    const verdict = { admitted: false, queuedReason: 'concurrency-limit' };
                    await reserve(verdict);
                    return verdict;
                },
            );
            await makeController().assignTask(auth, agentId, { taskId });
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'agent_task_assigned' }),
            );
        });
    });
});
