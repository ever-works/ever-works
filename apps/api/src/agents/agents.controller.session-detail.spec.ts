// Short-circuit the transitive `@ever-works/agent/*` import chain so
// the test doesn't pull `@src/entities` through the agent package —
// same pattern as `agents.controller.runtime.spec.ts`.
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
        AGENT_RUN_TRIGGERED: 'agent_run_triggered',
        AGENT_RUN_CANCELLED: 'agent_run_cancelled',
        AGENT_TASK_ASSIGNED: 'agent_task_assigned',
        AGENT_CREATED: 'agent_created',
        AGENT_PAUSED: 'agent_paused',
        AGENT_RESUMED: 'agent_resumed',
        AGENT_ARCHIVED: 'agent_archived',
        AGENT_UNARCHIVED: 'agent_unarchived',
        AGENT_EXPORTED: 'agent_exported',
        AGENT_IMPORTED: 'agent_imported',
        AGENT_BUDGET_EXCEEDED: 'agent_budget_exceeded',
    },
    ActivityStatus: { COMPLETED: 'completed' },
}));

import { NotFoundException } from '@nestjs/common';
import { AgentsController } from './agents.controller';

/**
 * Session detail (Feature K) — GET /api/agents/runs/:runId/detail.
 *
 * Pins the composition contract (session row + counts + timeline +
 * filesTouched), the cursor-pagination handshake, and the authz posture
 * (cross-user runId ⇒ 404 through the user-scoped repository lookup).
 */
describe('AgentsController — session detail (Feature K)', () => {
    let agentRuns: any;
    let agentRunLogs: any;
    let controller: AgentsController;

    const auth = { userId: 'u1' } as any;
    const runId = '00000000-0000-0000-0000-0000000000aa';

    const baseRun = () => ({
        id: runId,
        agentId: '00000000-0000-0000-0000-000000000001',
        userId: 'u1',
        status: 'running',
        triggerKind: 'task',
        taskId: '00000000-0000-0000-0000-0000000000bb',
        workId: null,
        awaitingInput: false,
        queuedReason: null,
        attentionReason: null,
        attentionAt: null,
        runnerKind: 'claude-code',
        startedAt: new Date('2026-08-14T10:00:00.000Z'),
        finishedAt: null,
        durationMs: null,
        summary: null,
        errorMessage: null,
        currentActivity: 'Editing files',
        totalTokens: 12400,
        changedFilesCount: 2,
        costCents: 34,
        gateStatus: null,
        gateAttempts: 0,
        resolvedChecks: null,
        checkResults: null,
        persistent: false,
        terminalState: 'attached',
        terminalEndedReason: null,
        terminalProviderId: 'local',
        chatMessageId: null,
        memorySessionId: null,
        workspaceMeta: {
            provider: 'workspace',
            baseSha: 'abc',
            branchRef: 'task/x',
            reused: false,
            filesTouched: ['src/a.ts', 'src/b.ts'],
        },
        createdAt: new Date('2026-08-14T09:59:00.000Z'),
    });

    const logRow = (over: Partial<Record<string, unknown>> = {}) => ({
        id: '00000000-0000-0000-0000-00000000cc01',
        runId,
        level: 'INFO',
        step: 'assistant-message',
        message: 'Hello.',
        metadata: { role: 'assistant', bytes: 6 },
        createdAt: new Date('2026-08-14T10:01:00.000Z'),
        ...over,
    });

    beforeEach(() => {
        agentRuns = {
            findByIdAndUser: jest.fn().mockResolvedValue(baseRun()),
            listSessionsForUser: jest.fn().mockResolvedValue([[], 0]),
        };
        agentRunLogs = {
            findByRun: jest.fn().mockResolvedValue([]),
            findTimelineByRun: jest.fn().mockResolvedValue([]),
            countByRunSteps: jest.fn().mockResolvedValue(0),
        };
        controller = new AgentsController(
            {} as any, // service
            {} as any, // files
            {} as any, // exportService
            {} as any, // dispatcher
            agentRuns,
            agentRunLogs,
            {} as any, // skillBindings
            {} as any, // pluginUsage
            {} as any, // tasks
            undefined, // activityLog
            undefined, // heartbeatTrigger
            undefined, // taskExecuteDispatcher
        );
    });

    it('⭐ 404s an unknown or cross-user runId (user-scoped lookup)', async () => {
        agentRuns.findByIdAndUser.mockResolvedValue(null);
        await expect(controller.getRunSessionDetail(auth, runId, {})).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(agentRuns.findByIdAndUser).toHaveBeenCalledWith(runId, 'u1');
    });

    it('⭐ composes run row + counts + filesTouched + timeline', async () => {
        agentRunLogs.countByRunSteps
            .mockResolvedValueOnce(7) // messages
            .mockResolvedValueOnce(19); // tool calls
        agentRunLogs.findTimelineByRun.mockResolvedValue([
            logRow(),
            logRow({
                id: '00000000-0000-0000-0000-00000000cc02',
                step: 'tool-invocation',
                level: 'WARN',
                message: 'Invoked tool "commitToRepo" (returned error).',
                metadata: {
                    toolName: 'commitToRepo',
                    callId: 'c1',
                    argsPreview: '{"message":"feat"}',
                    resultPreview: '{"error":"no repo"}',
                    durationMs: 41,
                },
                createdAt: new Date('2026-08-14T10:02:00.000Z'),
            }),
        ]);

        const res = await controller.getRunSessionDetail(auth, runId, {});

        expect(res.run).toEqual(
            expect.objectContaining({
                id: runId,
                status: 'running',
                runnerKind: 'claude-code',
                totalTokens: 12400,
                costCents: 34,
                sessionAttachable: true,
                chatMessageId: null,
                memorySessionId: null,
            }),
        );
        expect(res.counts).toEqual({ messages: 7, toolCalls: 19, filesTouched: 2 });
        expect(res.filesTouched).toEqual(['src/a.ts', 'src/b.ts']);
        expect(res.timeline.entries).toEqual([
            expect.objectContaining({
                kind: 'assistant-message',
                text: 'Hello.',
                toolName: null,
                isError: false,
            }),
            expect.objectContaining({
                kind: 'tool-call',
                text: null,
                toolName: 'commitToRepo',
                callId: 'c1',
                argsPreview: '{"message":"feat"}',
                resultPreview: '{"error":"no repo"}',
                durationMs: 41,
                isError: true,
            }),
        ]);
        // Short page ⇒ no further pages.
        expect(res.timeline.nextCursor).toBeNull();
    });

    it('falls back to changedFilesCount when no explicit paths were captured', async () => {
        const run = baseRun();
        run.workspaceMeta = null as any;
        run.changedFilesCount = 7;
        agentRuns.findByIdAndUser.mockResolvedValue(run);

        const res = await controller.getRunSessionDetail(auth, runId, {});

        expect(res.counts.filesTouched).toBe(7);
        expect(res.filesTouched).toEqual([]);
    });

    it('⭐ paginates: full page returns a nextCursor, cursor round-trips into the repository', async () => {
        const createdAt = new Date('2026-08-14T10:05:00.000Z');
        const lastId = '00000000-0000-0000-0000-00000000cc63';
        agentRunLogs.findTimelineByRun.mockResolvedValue(
            Array.from({ length: 2 }, (_, i) =>
                logRow({
                    id: i === 1 ? lastId : '00000000-0000-0000-0000-00000000cc62',
                    createdAt,
                }),
            ),
        );

        const first = await controller.getRunSessionDetail(auth, runId, { limit: 2 });
        expect(first.timeline.nextCursor).toBe(`${createdAt.getTime()}_${lastId}`);

        agentRunLogs.findTimelineByRun.mockResolvedValue([]);
        await controller.getRunSessionDetail(auth, runId, {
            limit: 2,
            cursor: first.timeline.nextCursor!,
        });
        expect(agentRunLogs.findTimelineByRun).toHaveBeenLastCalledWith(
            runId,
            expect.arrayContaining(['assistant-message', 'user-message', 'tool-invocation']),
            2,
            { createdAt, id: lastId },
        );
    });

    it('marks capture-truncated rows as marker entries', async () => {
        agentRunLogs.findTimelineByRun.mockResolvedValue([
            logRow({
                step: 'capture-truncated',
                message:
                    'Timeline capture cap reached (200 entries) — further message rows omitted.',
                metadata: { cap: 200 },
            }),
        ]);

        const res = await controller.getRunSessionDetail(auth, runId, {});
        expect(res.timeline.entries[0]).toEqual(
            expect.objectContaining({ kind: 'marker', toolName: null }),
        );
    });
});
