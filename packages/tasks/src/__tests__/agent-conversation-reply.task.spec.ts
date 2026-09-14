import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * `agent-conversation-reply` — an Agent answers a message in a named
 * Conversation. What this guards:
 *
 *  - the pre-created run is claimed, and a run that does not belong to this
 *    (Agent, message) pair, or already finished, is never executed;
 *  - the Agent is briefed with the message it answers (unresolved mentions
 *    stripped) and the recent history, through the shared runner;
 *  - a reply is recorded as the Agent's message answering the triggering one,
 *    and nothing is recorded when the run produced no reply.
 */
const {
    taskMock,
    createApplicationContextMock,
    StubInternalModule,
    AgentRepositoryToken,
    AgentRunRepositoryToken,
    AgentRunServiceToken,
    ConversationMessageServiceToken,
} = vi.hoisted(() => {
    class StubInternalModule {}
    class AgentRepositoryToken {}
    class AgentRunRepositoryToken {}
    class AgentRunServiceToken {}
    class ConversationMessageServiceToken {}
    return {
        taskMock: vi.fn(),
        createApplicationContextMock: vi.fn(),
        StubInternalModule,
        AgentRepositoryToken,
        AgentRunRepositoryToken,
        AgentRunServiceToken,
        ConversationMessageServiceToken,
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
vi.mock('@ever-works/agent/agents', () => ({ AgentRunService: AgentRunServiceToken }));
vi.mock('@ever-works/agent/conversations', () => ({
    ConversationMessageService: ConversationMessageServiceToken,
}));
vi.mock('../trigger/worker/modules/trigger-internal.module', () => ({
    TriggerInternalModule: StubInternalModule,
}));
vi.mock('../trigger/worker/trigger-logger', () => ({
    createTriggerLogger: vi.fn().mockReturnValue({}),
}));

type TaskConfig = {
    id: string;
    run: (payload: any, params?: any) => Promise<any>;
    onFailure: (params: { payload: any; error: unknown }) => Promise<void>;
};

const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '55555555-5555-4555-8555-555555555555';

const payload = {
    agentId: AGENT_ID,
    userId: OWNER,
    conversationId: CONVERSATION_ID,
    triggeringMessageId: MESSAGE_ID,
    runId: RUN_ID,
    dedupKey: `conversation:${MESSAGE_ID}:${AGENT_ID}:${RUN_ID}`,
};

describe('agentConversationReplyTask', () => {
    let agents: any;
    let runs: any;
    let runner: any;
    let messages: any;
    let config: TaskConfig;

    beforeAll(async () => {
        vi.resetModules();
        await import('../tasks/trigger/agent-conversation-reply.task');
        config = taskMock.mock.calls[taskMock.mock.calls.length - 1][0] as TaskConfig;
    });

    beforeEach(() => {
        vi.clearAllMocks();
        agents = { findByIdAndUser: vi.fn().mockResolvedValue({ id: AGENT_ID, userId: OWNER }) };
        runs = {
            findById: vi.fn().mockResolvedValue({
                id: RUN_ID,
                agentId: AGENT_ID,
                conversationMessageId: MESSAGE_ID,
                status: 'queued',
            }),
            createQueued: vi.fn().mockResolvedValue({ id: RUN_ID, status: 'queued' }),
            markStarted: vi.fn().mockResolvedValue(true),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
        };
        runner = {
            execute: vi.fn().mockResolvedValue({
                status: 'dispatched',
                outcome: { replyBody: '  Here is the plan.  ' },
            }),
        };
        messages = {
            loadReplyContext: vi.fn().mockResolvedValue({
                conversation: {
                    id: CONVERSATION_ID,
                    title: 'Launch',
                    contextType: 'mission',
                    contextId: 'mission-1',
                },
                triggering: { id: MESSAGE_ID, content: '@ghost draft the plan' },
                recent: [
                    {
                        id: MESSAGE_ID,
                        authorType: 'user',
                        authorId: OWNER,
                        role: 'user',
                        content: '@ghost draft the plan',
                        createdAt: new Date('2026-09-01T10:00:00Z'),
                    },
                ],
            }),
            agentVisibleBody: vi.fn().mockResolvedValue('draft the plan'),
            appendAgentMessage: vi.fn().mockResolvedValue({ id: 'reply-1' }),
        };
        createApplicationContextMock.mockResolvedValue({
            useLogger: vi.fn(),
            get: vi.fn().mockImplementation((token: unknown) => {
                if (token === AgentRepositoryToken) return agents;
                if (token === AgentRunRepositoryToken) return runs;
                if (token === AgentRunServiceToken) return runner;
                if (token === ConversationMessageServiceToken) return messages;
                throw new Error(`Unexpected DI token: ${String(token)}`);
            }),
            close: vi.fn().mockResolvedValue(undefined),
        });
    });

    it('registers under its own id', () => {
        expect(config.id).toBe('agent-conversation-reply');
    });

    it('claims the run, briefs the Agent and records the reply against the message', async () => {
        const result = await config.run(payload, { ctx: { run: { id: 'trigger-run-1' } } });

        expect(runs.markStarted).toHaveBeenCalledWith(RUN_ID, 'trigger-run-1');
        expect(messages.loadReplyContext).toHaveBeenCalledWith(OWNER, CONVERSATION_ID, MESSAGE_ID);
        expect(messages.agentVisibleBody).toHaveBeenCalledWith(OWNER, '@ghost draft the plan');
        expect(runner.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: RUN_ID,
                agentId: AGENT_ID,
                userId: OWNER,
                kind: 'chat',
                conversationMessageId: MESSAGE_ID,
                immediateInput: 'draft the plan',
                conversationContext: [
                    {
                        author: `user:${OWNER}`,
                        body: '@ghost draft the plan',
                        createdAt: '2026-09-01T10:00:00.000Z',
                    },
                ],
                scopeContext: 'Conversation: Launch\nAbout: mission mission-1',
            }),
        );
        expect(messages.appendAgentMessage).toHaveBeenCalledWith({
            conversationId: CONVERSATION_ID,
            agentId: AGENT_ID,
            body: 'Here is the plan.',
            replyToMessageId: MESSAGE_ID,
        });
        expect(result).toMatchObject({
            status: 'completed',
            runId: RUN_ID,
            replyMessageId: 'reply-1',
        });
    });

    it('records nothing when the run produced no reply', async () => {
        runner.execute.mockResolvedValue({ status: 'dispatched', outcome: { replyBody: '   ' } });
        await config.run(payload);
        expect(messages.appendAgentMessage).not.toHaveBeenCalled();

        runner.execute.mockResolvedValue({ status: 'budget-blocked' });
        const blocked = await config.run(payload);
        expect(messages.appendAgentMessage).not.toHaveBeenCalled();
        expect(blocked.status).toBe('budget-blocked');
    });

    it('never executes a run that belongs to another message or already finished', async () => {
        runs.findById.mockResolvedValueOnce({
            id: RUN_ID,
            agentId: AGENT_ID,
            conversationMessageId: 'another-message',
            status: 'queued',
        });
        await expect(config.run(payload)).resolves.toMatchObject({
            reason: 'run-payload-mismatch',
        });

        runs.findById.mockResolvedValueOnce({
            id: RUN_ID,
            agentId: AGENT_ID,
            conversationMessageId: MESSAGE_ID,
            status: 'cancelled',
        });
        await expect(config.run(payload)).resolves.toMatchObject({ reason: 'run-cancelled' });

        runs.markStarted.mockResolvedValueOnce(false);
        await expect(config.run(payload)).resolves.toMatchObject({
            reason: 'run-already-terminal',
        });

        expect(runner.execute).not.toHaveBeenCalled();
    });

    it('fails the run when the Conversation or message is gone', async () => {
        messages.loadReplyContext.mockResolvedValue(null);
        await expect(config.run(payload)).resolves.toMatchObject({
            reason: 'conversation-not-found',
        });
        expect(runs.markFailed).toHaveBeenCalledWith(RUN_ID, 'Conversation or message not found');
        expect(runner.execute).not.toHaveBeenCalled();
    });

    it('skips an Agent the dispatching user does not own', async () => {
        agents.findByIdAndUser.mockResolvedValue(null);
        await expect(config.run(payload)).resolves.toMatchObject({
            reason: 'agent-not-found-or-forbidden',
        });
        expect(runs.markStarted).not.toHaveBeenCalled();
    });

    it('refuses a payload whose ids are not uuids before touching the database', async () => {
        await expect(config.run({ ...payload, conversationId: 'nope' })).rejects.toThrow();
        expect(createApplicationContextMock).not.toHaveBeenCalled();
    });

    it('on failure, marks a still-live run failed', async () => {
        await config.onFailure({ payload, error: new Error('worker crashed') });
        expect(runs.markFailed).toHaveBeenCalledWith(RUN_ID, 'worker crashed');
    });
});
