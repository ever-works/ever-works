// Short-circuit the transitive `@ever-works/agent/*` import chain so
// the test doesn't pull `@src/entities` (which only resolves inside
// apps/api) through `packages/agent/src/database/repositories/...`.
// Mirrors the pattern used by `account/account.controller.spec.ts`.
jest.mock('@ever-works/agent/agents', () => ({
    __esModule: true,
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
    AGENT_FILE_NAMES: ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'],
    AgentScope: {
        TENANT: 'tenant',
        MISSION: 'mission',
        IDEA: 'idea',
        WORK: 'work',
    },
    AgentStatus: {
        DRAFT: 'draft',
        ACTIVE: 'active',
        PAUSED: 'paused',
        ERROR: 'error',
        ARCHIVED: 'archived',
    },
    AgentIdleBehavior: { PROPOSE: 'propose', SLEEP: 'sleep', SELF_IMPROVE: 'self-improve' },
    AgentAvatarMode: { INITIALS: 'initials', ICON: 'icon', IMAGE: 'image' },
    AGENT_PERMISSIONS_DEFAULT: {},
    AgentsService: class {},
    AgentFileService: class {},
    AgentExportService: class {},
    AgentScheduleDispatcherService: class {},
    AgentRunRepository: class {},
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
        AGENT_RUN_TRIGGERED: 'agent_run_triggered',
        AGENT_RUN_CANCELLED: 'agent_run_cancelled',
        AGENT_TASK_ASSIGNED: 'agent_task_assigned',
    },
    ActivityStatus: { COMPLETED: 'completed' },
}));

import { ConflictException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { AgentsController } from './agents.controller';

/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-2.
 *
 * Tests for the 6 new runtime endpoints. The controller talks to a
 * mix of services + repos + dispatcher tokens — these unit tests
 * stub each one with a jest mock and assert response shape +
 * dispatch / activity-log side effects. NOT run — operator runs the
 * suite.
 */
describe('AgentsController — runtime endpoints (FU-2)', () => {
    let service: any;
    let files: any;
    let exportService: any;
    let dispatcher: any;
    let agentRuns: any;
    let skillBindings: any;
    let pluginUsage: any;
    let tasks: any;
    let activityLog: any;
    let heartbeatTrigger: any;
    let taskExecuteDispatcher: any;
    let controller: AgentsController;

    const auth = { userId: 'u1' } as any;
    const agentId = '00000000-0000-0000-0000-000000000001';
    const runId = '00000000-0000-0000-0000-0000000000aa';
    const taskId = '00000000-0000-0000-0000-0000000000bb';

    beforeEach(() => {
        service = {
            getOne: jest.fn().mockResolvedValue({
                id: agentId,
                workId: null,
                missionId: null,
                ideaId: null,
            }),
        };
        files = {};
        exportService = {};
        dispatcher = { dispatchOne: jest.fn() };
        agentRuns = {
            findByAgent: jest.fn().mockResolvedValue([]),
            countByAgent: jest.fn().mockResolvedValue(0),
            cancel: jest.fn(),
            createQueued: jest.fn(),
            findInFlightForTaskAgent: jest.fn().mockResolvedValue(null),
            markFailed: jest.fn().mockResolvedValue(undefined),
        };
        skillBindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        pluginUsage = { getTotalSpendCentsForOwner: jest.fn().mockResolvedValue(0) };
        tasks = { getOne: jest.fn().mockResolvedValue({ id: taskId }) };
        activityLog = { log: jest.fn().mockResolvedValue(undefined) };
        heartbeatTrigger = { enqueue: jest.fn() };
        taskExecuteDispatcher = { enqueue: jest.fn().mockResolvedValue({ runId }) };

        controller = new AgentsController(
            service,
            files,
            exportService,
            dispatcher,
            agentRuns,
            skillBindings,
            pluginUsage,
            tasks,
            activityLog,
            heartbeatTrigger,
            taskExecuteDispatcher,
        );
    });

    describe('POST /:id/run-now', () => {
        it('dispatches when trigger is bound and Agent is reachable', async () => {
            dispatcher.dispatchOne.mockResolvedValueOnce({ outcome: 'dispatched', runId });
            const result = await controller.runNow(auth, agentId);
            expect(result).toEqual({ outcome: 'dispatched', runId });
            expect(dispatcher.dispatchOne).toHaveBeenCalledWith(heartbeatTrigger, agentId);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'agent_run_triggered',
                    userId: 'u1',
                }),
            );
        });

        it('throws 500 when AGENT_HEARTBEAT_TRIGGER is unbound', async () => {
            controller = new AgentsController(
                service,
                files,
                exportService,
                dispatcher,
                agentRuns,
                skillBindings,
                pluginUsage,
                tasks,
                activityLog,
                undefined,
                taskExecuteDispatcher,
            );
            await expect(controller.runNow(auth, agentId)).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );
        });

        it('returns "skipped already-claimed" when dispatchOne reports already-claimed', async () => {
            dispatcher.dispatchOne.mockResolvedValueOnce({
                outcome: 'skipped',
                reason: 'already-claimed',
            });
            const result = await controller.runNow(auth, agentId);
            expect(result).toEqual({ outcome: 'skipped', reason: 'already-claimed' });
        });

        it('throws 409 when Agent is not ACTIVE', async () => {
            dispatcher.dispatchOne.mockResolvedValueOnce({
                outcome: 'skipped',
                reason: 'inactive',
            });
            await expect(controller.runNow(auth, agentId)).rejects.toBeInstanceOf(
                ConflictException,
            );
        });
    });

    describe('GET /:id/runs', () => {
        it('returns paginated runs + total', async () => {
            agentRuns.findByAgent.mockResolvedValueOnce([
                {
                    id: runId,
                    status: 'completed',
                    triggerKind: 'heartbeat',
                    startedAt: new Date('2026-01-01T00:00:00Z'),
                    finishedAt: new Date('2026-01-01T00:00:05Z'),
                    durationMs: 5_000,
                    summary: 'ok',
                    errorMessage: null,
                    taskId: null,
                    createdAt: new Date('2026-01-01T00:00:00Z'),
                },
            ]);
            agentRuns.countByAgent.mockResolvedValueOnce(1);

            const result = await controller.listRuns(auth, agentId, { limit: 25, offset: 0 });
            expect(result.meta).toEqual({ total: 1, limit: 25, offset: 0 });
            expect(result.data).toHaveLength(1);
            expect(result.data[0]).toMatchObject({ status: 'completed' });
        });
    });

    describe('POST /:id/runs/:runId/cancel', () => {
        it('cancels a queued run, fires AGENT_RUN_CANCELLED activity', async () => {
            agentRuns.cancel.mockResolvedValueOnce({ found: true, previousStatus: 'queued' });
            const result = await controller.cancelRun(auth, agentId, runId);
            expect(result.cancelled).toBe(true);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'agent_run_cancelled' }),
            );
        });

        it('no-op on already-terminal run (no activity log row)', async () => {
            agentRuns.cancel.mockResolvedValueOnce({
                found: true,
                previousStatus: 'completed',
            });
            const result = await controller.cancelRun(auth, agentId, runId);
            expect(result.cancelled).toBe(false);
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('throws 404 when run-id not found', async () => {
            agentRuns.cancel.mockResolvedValueOnce({ found: false });
            await expect(controller.cancelRun(auth, agentId, runId)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('GET /:id/skills', () => {
        it('returns bound skills via resolveActive', async () => {
            skillBindings.resolveActive.mockResolvedValueOnce([
                {
                    binding: {
                        id: 'b1',
                        priority: 1,
                        targetType: 'agent',
                    },
                    skill: {
                        id: 's1',
                        slug: 'helpful',
                        title: 'Helpful',
                        version: '1.0.0',
                    },
                },
            ]);
            const result = await controller.listSkills(auth, agentId);
            expect(result.data).toHaveLength(1);
            expect(result.data[0].skill.slug).toBe('helpful');
            expect(skillBindings.resolveActive).toHaveBeenCalledWith(
                expect.objectContaining({ agentId, userId: 'u1', forAgentRun: true }),
            );
        });
    });

    describe('GET /:id/budget', () => {
        it('returns 30-day spend rollup from PluginUsageRepository', async () => {
            pluginUsage.getTotalSpendCentsForOwner.mockResolvedValueOnce(12345);
            const result = await controller.getBudget(auth, agentId);
            expect(result.currentSpendCents).toBe(12345);
            expect(result.currency).toBe('USD');
            expect(pluginUsage.getTotalSpendCentsForOwner).toHaveBeenCalledWith(
                'agent',
                agentId,
                expect.any(Date),
                expect.any(Date),
                undefined,
                'USD',
            );
        });
    });

    describe('POST /:id/assign-task', () => {
        it('pre-creates AgentRun + dispatches agent-task-execute', async () => {
            agentRuns.createQueued.mockResolvedValueOnce({ id: runId });
            const result = await controller.assignTask(auth, agentId, { taskId });
            expect(result.runId).toBe(runId);
            expect(taskExecuteDispatcher.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({ agentId, taskId, userId: 'u1' }),
            );
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'agent_task_assigned' }),
            );
        });

        it('returns the in-flight runId without dispatching when one is already running', async () => {
            agentRuns.findInFlightForTaskAgent.mockResolvedValueOnce({ id: runId });
            const result = await controller.assignTask(auth, agentId, { taskId });
            expect(result.runId).toBe(runId);
            expect(taskExecuteDispatcher.enqueue).not.toHaveBeenCalled();
            expect(agentRuns.createQueued).not.toHaveBeenCalled();
        });

        it('rolls back the queued AgentRun when enqueue throws (codex P1 fix)', async () => {
            agentRuns.createQueued.mockResolvedValueOnce({ id: runId });
            taskExecuteDispatcher.enqueue.mockRejectedValueOnce(new Error('trigger.dev down'));
            await expect(controller.assignTask(auth, agentId, { taskId })).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );
            expect(agentRuns.markFailed).toHaveBeenCalledWith(
                runId,
                expect.stringContaining('enqueue-failed'),
            );
        });

        it('throws 500 when AGENT_TASK_EXECUTE_DISPATCHER is unbound', async () => {
            controller = new AgentsController(
                service,
                files,
                exportService,
                dispatcher,
                agentRuns,
                skillBindings,
                pluginUsage,
                tasks,
                activityLog,
                heartbeatTrigger,
                undefined,
            );
            await expect(controller.assignTask(auth, agentId, { taskId })).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );
        });
    });
});
