import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * Reviewer agent stage (slice AD, EW-811) — the chat-reply worker executes a
 * claimed row under that row's OWN admission scope.
 *
 * Review finding "scope from the context, verdict from the row": the T6
 * chat-dedup fallback (`findInFlightForTaskAgent`, used when a payload carries
 * no `runId`) claims ANY in-flight run of the mentioned agent on the Task —
 * which, while a review is running, is the REVIEW run. `AgentRunService`
 * narrows the tool surface, gates a review run on its brief and offers the
 * verdict tool only from the scope on the CONTEXT, and this worker used to
 * leave it off, so such a row ran with the agent's full tool surface.
 */
const {
    taskMock,
    createApplicationContextMock,
    StubInternalModule,
    AgentRepositoryToken,
    AgentRunRepositoryToken,
    AgentRunServiceToken,
    TasksServiceToken,
    TaskChatServiceToken,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class AgentRepositoryToken {}
    class AgentRunRepositoryToken {}
    class AgentRunServiceToken {}
    class TasksServiceToken {}
    class TaskChatServiceToken {}
    return {
        taskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        StubInternalModule,
        AgentRepositoryToken,
        AgentRunRepositoryToken,
        AgentRunServiceToken,
        TasksServiceToken,
        TaskChatServiceToken,
    };
});

vi.mock('@trigger.dev/sdk', () => ({
    task: taskMock,
    schedules: { task: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@nestjs/core', () => ({
    NestFactory: { createApplicationContext: createApplicationContextMock },
}));

vi.mock('@ever-works/agent/database', () => ({
    AgentRepository: AgentRepositoryToken,
    AgentRunRepository: AgentRunRepositoryToken,
}));

vi.mock('@ever-works/agent/agents', () => ({
    AgentRunService: AgentRunServiceToken,
}));

vi.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: TasksServiceToken,
    TaskChatService: TaskChatServiceToken,
}));

vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));

vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: vi.fn().mockReturnValue({ __kind: 'trigger-logger' }),
}));

type TaskConfig = {
    id: string;
    run: (payload: any, params?: any) => Promise<any>;
};

const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const REVIEW_SCOPE = { allowedTools: ['submitTaskReview'] };

describe('agentChatReplyTask — a claimed row runs under its OWN admission scope', () => {
    let registeredConfig: TaskConfig;
    let runs: any;
    let runner: any;

    beforeAll(async () => {
        vi.resetModules();
        await import('../tasks/trigger/agent-chat-reply.task');
        registeredConfig = taskMock.mock.calls[taskMock.mock.calls.length - 1][0] as TaskConfig;
    });

    beforeEach(() => {
        vi.clearAllMocks();
        const agents = {
            findByIdAndUser: vi.fn().mockResolvedValue({ id: AGENT_ID, userId: OWNER }),
        };
        runs = {
            findById: vi.fn().mockResolvedValue(null),
            findInFlightForTaskAgent: vi.fn().mockResolvedValue(null),
            createQueued: vi.fn().mockResolvedValue({ id: 'run-chat-1', status: 'queued' }),
            markStarted: vi.fn().mockResolvedValue(true),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
        };
        runner = { execute: vi.fn().mockResolvedValue({ status: 'dispatched' }) };
        const tasks = { getOne: vi.fn().mockResolvedValue(null) };
        const chat = {
            list: vi
                .fn()
                .mockResolvedValue([
                    { id: MESSAGE_ID, authorType: 'user', authorId: OWNER, body: '@reviewer why?' },
                ]),
        };
        createApplicationContextMock.mockResolvedValue({
            useLogger: vi.fn(),
            get: vi.fn().mockImplementation((token: unknown) => {
                if (token === AgentRepositoryToken) return agents;
                if (token === AgentRunRepositoryToken) return runs;
                if (token === AgentRunServiceToken) return runner;
                if (token === TasksServiceToken) return tasks;
                if (token === TaskChatServiceToken) return chat;
                throw new Error(`Unexpected DI token: ${String(token)}`);
            }),
            close: vi.fn().mockResolvedValue(undefined),
        });
    });

    const payload = {
        agentId: AGENT_ID,
        userId: OWNER,
        taskId: TASK_ID,
        triggeringMessageId: MESSAGE_ID,
        dedupKey: `${TASK_ID}:${AGENT_ID}:${MESSAGE_ID}`,
    };

    it('carries a REVIEW row’s scope when the T6 fallback claims the live review run', async () => {
        runs.findInFlightForTaskAgent.mockResolvedValueOnce({
            id: 'run-review-1',
            agentId: AGENT_ID,
            taskId: TASK_ID,
            status: 'running',
            delegationScope: REVIEW_SCOPE,
        });

        await registeredConfig.run(payload, { ctx: { run: { id: 'run_abc' } } });

        expect(runner.execute).toHaveBeenCalledTimes(1);
        expect(runner.execute.mock.calls[0][0]).toMatchObject({
            runId: 'run-review-1',
            kind: 'chat',
            delegationScope: REVIEW_SCOPE,
        });
    });

    it('leaves an ordinary chat reply exactly as it was — no scope key at all', async () => {
        await registeredConfig.run(payload, { ctx: { run: { id: 'run_abc' } } });

        expect(runner.execute).toHaveBeenCalledTimes(1);
        expect(runner.execute.mock.calls[0][0].runId).toBe('run-chat-1');
        expect(runner.execute.mock.calls[0][0]).not.toHaveProperty('delegationScope');
    });
});
