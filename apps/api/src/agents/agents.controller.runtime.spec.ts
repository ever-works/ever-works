// Short-circuit the transitive `@ever-works/agent/*` import chain so
// the test doesn't pull `@src/entities` (which only resolves inside
// apps/api) through `packages/agent/src/database/repositories/...`.
// Mirrors the pattern used by `account/account.controller.spec.ts`.
jest.mock('@ever-works/agent/agents', () => ({
    __esModule: true,
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
    AGENT_RUN_CANCELLER: 'AGENT_RUN_CANCELLER',
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
    AgentRunLogRepository: class {},
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
        AGENT_CREATED: 'agent_created',
        AGENT_PAUSED: 'agent_paused',
        AGENT_RESUMED: 'agent_resumed',
        AGENT_ARCHIVED: 'agent_archived',
        AGENT_EXPORTED: 'agent_exported',
        AGENT_IMPORTED: 'agent_imported',
        AGENT_BUDGET_EXCEEDED: 'agent_budget_exceeded',
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
    let agentRunLogs: any;
    let skillBindings: any;
    let pluginUsage: any;
    let tasks: any;
    let activityLog: any;
    let heartbeatTrigger: any;
    let taskExecuteDispatcher: any;
    let runCanceller: any;
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
            // Security (EW-710 wave M): listRuns now calls the user-scoped
            // repository variants instead of the @internal unscoped
            // findByAgent/countByAgent (latent-IDOR hardening).
            findByAgentAndUser: jest.fn().mockResolvedValue([]),
            countByAgentAndUser: jest.fn().mockResolvedValue(0),
            cancel: jest.fn(),
            createQueued: jest.fn(),
            findInFlightForTaskAgent: jest.fn().mockResolvedValue(null),
            markFailed: jest.fn().mockResolvedValue(undefined),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
            findByIdAndUser: jest.fn().mockResolvedValue(null),
        };
        agentRunLogs = { findByRun: jest.fn().mockResolvedValue([]) };
        skillBindings = { resolveActive: jest.fn().mockResolvedValue([]) };
        pluginUsage = { getTotalSpendCentsForOwner: jest.fn().mockResolvedValue(0) };
        tasks = { getOne: jest.fn().mockResolvedValue({ id: taskId }) };
        activityLog = {
            log: jest.fn().mockResolvedValue(undefined),
            findAgentEvents: jest.fn().mockResolvedValue({ activities: [], total: 0 }),
        };
        heartbeatTrigger = { enqueue: jest.fn() };
        taskExecuteDispatcher = { enqueue: jest.fn().mockResolvedValue({ runId }) };
        runCanceller = { cancel: jest.fn().mockResolvedValue('cancelled') };

        controller = new AgentsController(
            service,
            files,
            exportService,
            dispatcher,
            agentRuns,
            agentRunLogs,
            skillBindings,
            pluginUsage,
            tasks,
            activityLog,
            heartbeatTrigger,
            taskExecuteDispatcher,
            runCanceller,
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
                agentRunLogs,
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
            // Security (EW-710 wave M): the controller must use the
            // user-scoped findByAgentAndUser/countByAgentAndUser so run
            // history stays ownership-filtered at the repository layer
            // even if the service-level getOne() gate is ever removed.
            agentRuns.findByAgentAndUser.mockResolvedValueOnce([
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
            agentRuns.countByAgentAndUser.mockResolvedValueOnce(1);

            const result = await controller.listRuns(auth, agentId, { limit: 25, offset: 0 });
            expect(result.meta).toEqual({ total: 1, limit: 25, offset: 0 });
            expect(result.data).toHaveLength(1);
            expect(result.data[0]).toMatchObject({ status: 'completed' });
            expect(agentRuns.findByAgentAndUser).toHaveBeenCalledWith(agentId, 'u1', 25, 0);
            expect(agentRuns.countByAgentAndUser).toHaveBeenCalledWith(agentId, 'u1');
        });
    });

    describe('GET /:id/runs/:runId', () => {
        const runRow = {
            id: runId,
            agentId,
            status: 'failed',
            triggerKind: 'task',
            startedAt: new Date('2026-01-01T00:00:00Z'),
            finishedAt: new Date('2026-01-01T00:00:05Z'),
            durationMs: 5_000,
            summary: 'partial note',
            errorMessage: 'provider timeout',
            taskId,
            chatMessageId: null,
            memorySessionId: 'sess-1',
            createdAt: new Date('2026-01-01T00:00:00Z'),
        };

        it('returns full run detail + ordered step logs', async () => {
            agentRuns.findByIdAndUser.mockResolvedValueOnce(runRow);
            agentRunLogs.findByRun.mockResolvedValueOnce([
                {
                    id: 'log-1',
                    level: 'INFO',
                    step: 'provider-call',
                    message: 'dispatched',
                    metadata: { totalTokens: 42 },
                    createdAt: new Date('2026-01-01T00:00:01Z'),
                },
            ]);
            const result = await controller.getRun(auth, agentId, runId);
            expect(result).toMatchObject({
                id: runId,
                status: 'failed',
                summary: 'partial note',
                errorMessage: 'provider timeout',
                memorySessionId: 'sess-1',
            });
            expect(result.logs).toHaveLength(1);
            expect(result.logs[0]).toMatchObject({
                level: 'INFO',
                step: 'provider-call',
                metadata: { totalTokens: 42 },
            });
            expect(agentRuns.findByIdAndUser).toHaveBeenCalledWith(runId, 'u1');
            expect(agentRunLogs.findByRun).toHaveBeenCalledWith(runId, 500);
        });

        it('throws 404 when the run does not exist for this user', async () => {
            agentRuns.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(controller.getRun(auth, agentId, runId)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('throws 404 when the run belongs to a different agent (no cross-agent read)', async () => {
            agentRuns.findByIdAndUser.mockResolvedValueOnce({
                ...runRow,
                agentId: '00000000-0000-0000-0000-0000000000ff',
            });
            await expect(controller.getRun(auth, agentId, runId)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(agentRunLogs.findByRun).not.toHaveBeenCalled();
        });
    });

    describe('POST /:id/pause + /:id/resume', () => {
        it('pause logs AGENT_PAUSED with the agent as resource', async () => {
            service.pause = jest.fn().mockResolvedValue({ id: agentId, status: 'paused' });
            const result = await controller.pause(auth, agentId);
            expect(result.status).toBe('paused');
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'agent_paused',
                    userId: 'u1',
                    details: expect.objectContaining({ resourceId: agentId }),
                }),
            );
        });

        it('resume logs AGENT_RESUMED', async () => {
            service.resume = jest.fn().mockResolvedValue({ id: agentId, status: 'active' });
            const result = await controller.resume(auth, agentId);
            expect(result.status).toBe('active');
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: 'agent_resumed' }),
            );
        });

        it('does not log when the transition throws', async () => {
            service.pause = jest.fn().mockRejectedValue(new ConflictException('raced'));
            await expect(controller.pause(auth, agentId)).rejects.toBeInstanceOf(ConflictException);
            expect(activityLog.log).not.toHaveBeenCalled();
        });
    });

    describe('GET /:id/events', () => {
        it('returns paginated lifecycle events scoped to this agent', async () => {
            activityLog.findAgentEvents.mockResolvedValueOnce({
                activities: [
                    {
                        id: 'evt-1',
                        actionType: 'agent_paused',
                        details: { status: 'paused', resourceId: agentId },
                        createdAt: new Date('2026-01-02T00:00:00Z'),
                    },
                ],
                total: 1,
            });
            const result = await controller.listEvents(auth, agentId, { limit: 25, offset: 0 });
            expect(result.meta).toEqual({ total: 1, limit: 25, offset: 0 });
            expect(result.data[0]).toMatchObject({ id: 'evt-1', actionType: 'agent_paused' });
            expect(activityLog.findAgentEvents).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    agentId,
                    actionTypes: expect.arrayContaining(['agent_paused', 'agent_resumed']),
                }),
            );
        });

        it('returns an empty page when ActivityLogService is unbound', async () => {
            controller = new AgentsController(
                service,
                files,
                exportService,
                dispatcher,
                agentRuns,
                agentRunLogs,
                skillBindings,
                pluginUsage,
                tasks,
                undefined,
                heartbeatTrigger,
                taskExecuteDispatcher,
            );
            const result = await controller.listEvents(auth, agentId, {});
            expect(result).toEqual({ data: [], meta: { total: 0, limit: 25, offset: 0 } });
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

        it('also cancels the Trigger.dev run when the row carries a triggerRunId', async () => {
            agentRuns.cancel.mockResolvedValueOnce({
                found: true,
                previousStatus: 'running',
                triggerRunId: 'run_abc',
            });
            const result = await controller.cancelRun(auth, agentId, runId);
            expect(result.cancelled).toBe(true);
            // The whole point: cancelling must stop real compute, not just
            // flip a DB row. Passes the Trigger.dev id, NOT the AgentRun UUID.
            expect(runCanceller.cancel).toHaveBeenCalledWith('run_abc');
        });

        it('skips the remote cancel when the run was never stamped', async () => {
            agentRuns.cancel.mockResolvedValueOnce({
                found: true,
                previousStatus: 'queued',
                triggerRunId: null,
            });
            const result = await controller.cancelRun(auth, agentId, runId);
            expect(result.cancelled).toBe(true);
            expect(runCanceller.cancel).not.toHaveBeenCalled();
        });

        it('does not cancel remotely for an already-terminal run', async () => {
            agentRuns.cancel.mockResolvedValueOnce({
                found: true,
                previousStatus: 'completed',
                triggerRunId: 'run_abc',
            });
            const result = await controller.cancelRun(auth, agentId, runId);
            expect(result.cancelled).toBe(false);
            expect(runCanceller.cancel).not.toHaveBeenCalled();
        });

        it('still reports cancelled when the canceller reports a non-cancelled outcome', async () => {
            // Trigger.dev disabled, or the run was already terminal on their
            // side. The DB CAS is the authoritative answer, so the endpoint
            // must not turn a benign race into a 5xx.
            runCanceller.cancel.mockResolvedValueOnce('not-configured');
            agentRuns.cancel.mockResolvedValueOnce({
                found: true,
                previousStatus: 'running',
                triggerRunId: 'run_abc',
            });
            await expect(controller.cancelRun(auth, agentId, runId)).resolves.toEqual(
                expect.objectContaining({ cancelled: true }),
            );
        });

        it('degrades to a DB-only cancel when AGENT_RUN_CANCELLER is unbound', async () => {
            const noCanceller = new AgentsController(
                service,
                files,
                exportService,
                dispatcher,
                agentRuns,
                agentRunLogs,
                skillBindings,
                pluginUsage,
                tasks,
                activityLog,
                heartbeatTrigger,
                taskExecuteDispatcher,
                undefined,
            );
            agentRuns.cancel.mockResolvedValueOnce({
                found: true,
                previousStatus: 'running',
                triggerRunId: 'run_abc',
            });
            await expect(noCanceller.cancelRun(auth, agentId, runId)).resolves.toEqual(
                expect.objectContaining({ cancelled: true }),
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
                expect.objectContaining({ agentId, taskId, userId: 'u1', runId }),
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
            // FU-3: the rollback goes through markDispatchFailed, which is
            // `queued`-only, so it can never stomp a run the worker already
            // started after an enqueue that timed out but was accepted.
            expect(agentRuns.markDispatchFailed).toHaveBeenCalledWith(
                runId,
                expect.stringContaining('enqueue-failed'),
            );
            expect(agentRuns.markFailed).not.toHaveBeenCalled();
        });

        it('throws 500 when AGENT_TASK_EXECUTE_DISPATCHER is unbound', async () => {
            controller = new AgentsController(
                service,
                files,
                exportService,
                dispatcher,
                agentRuns,
                agentRunLogs,
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
