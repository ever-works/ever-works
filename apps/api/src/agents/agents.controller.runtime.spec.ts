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
    // Wave 4 M2/M3 — dispatch gate injected for cancel-path draining.
    RunDispatchGateService: class {},
    // Wave 4 M5 — steer / interrupt / resume run controls.
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
            // Wave 4 M3 — org-wide Sessions list (owner-scoped variant).
            listSessionsForUser: jest.fn().mockResolvedValue([[], 0]),
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

    describe('GET /runs — Sessions list (Wave 4 M3)', () => {
        it('is owner-scoped at the repository layer — userId always comes from auth', async () => {
            // Security: no agent ownership pre-check exists on this route
            // (it spans all the caller's Agents), so the repository-level
            // userId scope is the ONLY guard. Pin that the controller
            // passes auth.userId, never anything caller-controlled.
            await controller.listRunSessions(auth, {});
            expect(agentRuns.listSessionsForUser).toHaveBeenCalledWith(
                'u1',
                {
                    status: undefined,
                    workId: undefined,
                    agentId: undefined,
                    taskId: undefined,
                    triggerKind: undefined,
                    // Wave 4 M6 - absent `attention` never narrows the list.
                    attention: false,
                },
                25,
                0,
            );
        });

        it('forwards filters (status/workId/agentId/kind) and pagination', async () => {
            const workId = '00000000-0000-0000-0000-0000000000cc';
            await controller.listRunSessions(auth, {
                status: 'running',
                workId,
                agentId,
                kind: 'task',
                limit: 5,
                offset: 10,
            });
            expect(agentRuns.listSessionsForUser).toHaveBeenCalledWith(
                'u1',
                {
                    status: 'running',
                    workId,
                    agentId,
                    taskId: undefined,
                    triggerKind: 'task',
                    attention: false,
                },
                5,
                10,
            );
        });

        it('forwards the needs-attention quick filter (Wave 4 M6)', async () => {
            // The notification deep-links to `?attention=1`, so this exact
            // wire value has to reach the repository as a narrowing filter.
            await controller.listRunSessions(auth, { attention: '1' });
            expect(agentRuns.listSessionsForUser).toHaveBeenCalledWith(
                'u1',
                expect.objectContaining({ attention: true }),
                25,
                0,
            );
        });

        it('returns telemetry + gate + terminal + orchestration columns per row', async () => {
            agentRuns.listSessionsForUser.mockResolvedValueOnce([
                [
                    {
                        id: runId,
                        agentId,
                        status: 'running',
                        triggerKind: 'task',
                        taskId,
                        workId: '00000000-0000-0000-0000-0000000000cc',
                        awaitingInput: false,
                        queuedReason: null,
                        runnerKind: 'claude-code',
                        startedAt: new Date('2026-01-01T00:00:00Z'),
                        finishedAt: null,
                        durationMs: null,
                        summary: null,
                        errorMessage: null,
                        currentActivity: 'editing src/auth/session.ts',
                        totalTokens: 48_200,
                        changedFilesCount: 3,
                        costCents: 120,
                        gateStatus: 'pending',
                        gateAttempts: 1,
                        persistent: true,
                        terminalState: 'attached',
                        terminalEndedReason: null,
                        terminalProviderId: 'terminal-relay',
                        createdAt: new Date('2026-01-01T00:00:00Z'),
                    },
                ],
                1,
            ]);
            const result = await controller.listRunSessions(auth, {});
            expect(result.meta).toEqual({ total: 1, limit: 25, offset: 0 });
            expect(result.data[0]).toMatchObject({
                id: runId,
                workId: '00000000-0000-0000-0000-0000000000cc',
                awaitingInput: false,
                queuedReason: null,
                runnerKind: 'claude-code',
                currentActivity: 'editing src/auth/session.ts',
                totalTokens: 48_200,
                changedFilesCount: 3,
                costCents: 120,
                gateStatus: 'pending',
                gateAttempts: 1,
                persistent: true,
                terminalState: 'attached',
            });
        });

        describe('sessionAttachable (Wave 4 M8)', () => {
            function sessionRow(over: Record<string, unknown> = {}) {
                return {
                    id: runId,
                    agentId,
                    status: 'running',
                    triggerKind: 'task',
                    taskId,
                    workId: null,
                    awaitingInput: false,
                    queuedReason: null,
                    runnerKind: null,
                    startedAt: null,
                    finishedAt: null,
                    durationMs: null,
                    summary: null,
                    errorMessage: null,
                    currentActivity: null,
                    totalTokens: null,
                    changedFilesCount: null,
                    costCents: null,
                    gateStatus: null,
                    gateAttempts: 0,
                    persistent: true,
                    terminalState: 'attached',
                    terminalEndedReason: null,
                    terminalProviderId: null,
                    createdAt: new Date('2026-01-01T00:00:00Z'),
                    ...over,
                };
            }

            async function attachableFor(over: Record<string, unknown>) {
                agentRuns.listSessionsForUser.mockResolvedValueOnce([[sessionRow(over)], 1]);
                const result = await controller.listRunSessions(auth, {});
                return result.data[0].sessionAttachable;
            }

            it('⭐ is true for a live run with an attached terminal', async () => {
                expect(await attachableFor({ status: 'running', terminalState: 'attached' })).toBe(
                    true,
                );
            });

            it('is true while the terminal is still starting', async () => {
                expect(await attachableFor({ status: 'queued', terminalState: 'starting' })).toBe(
                    true,
                );
            });

            it('⭐ is FALSE for a terminal run whose columns still read attached', async () => {
                // The worker's last write before it died can legitimately still
                // say `attached` for minutes, until the terminal sweeper
                // corrects it. Offering Attach there is a guaranteed dead end —
                // this is exactly what gating on `terminalState` alone got
                // wrong.
                expect(
                    await attachableFor({ status: 'completed', terminalState: 'attached' }),
                ).toBe(false);
            });

            it('is false once the terminal has ended', async () => {
                expect(await attachableFor({ status: 'running', terminalState: 'ended' })).toBe(
                    false,
                );
            });

            it('is false for a run that never had a terminal', async () => {
                expect(await attachableFor({ status: 'running', terminalState: null })).toBe(false);
            });
        });
    });

    /**
     * Run steering (Wave 4 M5) — steer / interrupt / resume.
     *
     * The controller is deliberately thin: it re-asserts Agent ownership
     * (cross-user 404 via `service.getOne`) and hands off to
     * `RunSteeringService`, which owns the run-level ownership scope and the
     * 409 state rules. These tests pin the wiring and the two things the
     * controller itself does — the ownership pre-check and the executor
     * activity trail.
     */
    describe('run controls — steer / interrupt / resume', () => {
        let steering: any;

        function makeControllerWithSteering(bound = true): AgentsController {
            return new AgentsController(
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
                undefined,
                undefined,
                bound ? steering : undefined,
            );
        }

        beforeEach(() => {
            steering = {
                steer: jest
                    .fn()
                    .mockResolvedValue({ dispatched: 'injected', runId, queuedCount: 1 }),
                interrupt: jest.fn().mockResolvedValue({ interrupted: true, runId }),
                resume: jest.fn().mockResolvedValue({
                    dispatched: 'new-run',
                    runId: '00000000-0000-0000-0000-0000000000dd',
                    resumedFromRunId: runId,
                    carriedCliSession: true,
                    queued: false,
                }),
            };
            controller = makeControllerWithSteering();
        });

        it('⭐ steer forwards the auth user, never a caller-supplied one', async () => {
            const result = await controller.steerRun(auth, agentId, runId, { message: 'go left' });
            expect(result).toMatchObject({ dispatched: 'injected', runId });
            expect(steering.steer).toHaveBeenCalledWith({
                runId,
                userId: 'u1',
                message: 'go left',
            });
        });

        it('steer 404s a cross-user Agent before touching the run', async () => {
            service.getOne.mockRejectedValueOnce(new NotFoundException('nope'));
            await expect(
                controller.steerRun(auth, agentId, runId, { message: 'go left' }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(steering.steer).not.toHaveBeenCalled();
        });

        it('steer answers new-run for an already-finished run (not an error)', async () => {
            steering.steer.mockResolvedValueOnce({ dispatched: 'new-run', runId });
            const result = await controller.steerRun(auth, agentId, runId, { message: 'go left' });
            expect(result.dispatched).toBe('new-run');
        });

        it('⭐ interrupt surfaces the service 409 for a terminal run', async () => {
            steering.interrupt.mockRejectedValueOnce(new ConflictException('already terminal'));
            await expect(controller.interruptRun(auth, agentId, runId)).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('interrupt records an activity row for the acting user', async () => {
            await controller.interruptRun(auth, agentId, runId);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    details: expect.objectContaining({ runId, control: 'interrupt' }),
                }),
            );
        });

        it('resume forwards the optional message and returns the NEW run id', async () => {
            const result = await controller.resumeRun(auth, agentId, runId, { message: 'go on' });
            expect(steering.resume).toHaveBeenCalledWith(runId, 'u1', 'go on');
            expect(result).toMatchObject({
                dispatched: 'new-run',
                resumedFromRunId: runId,
                carriedCliSession: true,
            });
        });

        it('resume passes null when no message was sent ("carry on")', async () => {
            await controller.resumeRun(auth, agentId, runId, {});
            expect(steering.resume).toHaveBeenCalledWith(runId, 'u1', null);
        });

        it('resume surfaces the service 409 for a non-resumable run', async () => {
            steering.resume.mockRejectedValueOnce(new ConflictException('still running'));
            await expect(controller.resumeRun(auth, agentId, runId, {})).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('500s rather than answering 200 when the steering service is unbound', async () => {
            const unbound = makeControllerWithSteering(false);
            await expect(
                unbound.steerRun(auth, agentId, runId, { message: 'x' }),
            ).rejects.toBeInstanceOf(InternalServerErrorException);
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

        it('queries for the run-lifecycle events this controller actually emits', async () => {
            // run-now, cancel and assign-task all write activity rows via
            // tryLog(), but were missing from AGENT_LIFECYCLE_EVENT_TYPES — so
            // they were persisted and then never returned by this endpoint.
            // Assert on the emitted set, not just the status-transition ones.
            await controller.listEvents(auth, agentId, {});
            const { actionTypes } = activityLog.findAgentEvents.mock.calls[0][0];
            expect(actionTypes).toEqual(
                expect.arrayContaining([
                    'agent_run_triggered',
                    'agent_run_cancelled',
                    'agent_task_assigned',
                ]),
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

        it('drains the Work concurrency queue after cancelling an open run (Wave 4 M2)', async () => {
            const workId = '00000000-0000-0000-0000-0000000000cc';
            const dispatchGate = {
                drainForWork: jest.fn().mockResolvedValue({ dispatched: true }),
            };
            const gated = new AgentsController(
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
                dispatchGate as any,
            );
            agentRuns.cancel.mockResolvedValueOnce({
                found: true,
                previousStatus: 'running',
                triggerRunId: 'run_abc',
                workId,
            });
            await gated.cancelRun(auth, agentId, runId);
            await new Promise((r) => setImmediate(r)); // fire-and-forget drain
            expect(dispatchGate.drainForWork).toHaveBeenCalledWith(workId);
        });

        it('does NOT drain after a no-op cancel of an already-terminal run', async () => {
            const dispatchGate = { drainForWork: jest.fn() };
            const gated = new AgentsController(
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
                dispatchGate as any,
            );
            agentRuns.cancel.mockResolvedValueOnce({
                found: true,
                previousStatus: 'completed',
                workId: '00000000-0000-0000-0000-0000000000cc',
            });
            await gated.cancelRun(auth, agentId, runId);
            await new Promise((r) => setImmediate(r));
            expect(dispatchGate.drainForWork).not.toHaveBeenCalled();
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
