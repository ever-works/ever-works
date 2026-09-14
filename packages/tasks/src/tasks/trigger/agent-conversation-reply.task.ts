import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { AgentRunService } from '@ever-works/agent/agents';
import { ConversationMessageService } from '@ever-works/agent/conversations';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
// Security: validate every payload id before any DB access.
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';

export interface AgentConversationReplyPayload {
    agentId: string;
    userId: string;
    conversationId: string;
    runId?: string;
    /** The person's message the Agent is answering. */
    triggeringMessageId: string;
    /** Run-scoped idempotency key — `conversation:${messageId}:${agentId}:${runId}`. */
    dedupKey: string;
}

/**
 * One-shot job: an Agent answers a message in a named Conversation.
 *
 * Dispatched by `ConversationDispatchService` through
 * `AGENT_CONVERSATION_REPLY_DISPATCHER` for every Agent a message addresses,
 * after the dispatch gate admitted it and the run row was created. Modelled
 * on `agent-chat-reply.task.ts`:
 *
 *  1. validate the payload and load the Agent for the dispatching user;
 *  2. claim the pre-created run (CAS — a cancelled or reaped run is skipped);
 *  3. brief the Agent with the Conversation: the message it answers (with
 *     unresolved mentions stripped), the recent messages, and what the
 *     Conversation is about;
 *  4. execute through `AgentRunService`, the same runner every Agent run uses
 *     (budget, tools, memory, cost);
 *  5. record the reply as an Agent-authored message that answers the
 *     triggering one, so the run and the message point at each other — or,
 *     when the Agent's budget refused the run (`budget_exceeded`) or the
 *     model call failed (`provider_unavailable`), mark the triggering message
 *     `failed` so the failure is visible and retryable.
 *
 * `maxDuration` matches the chat reply job.
 */
export const agentConversationReplyTask = task<
    'agent-conversation-reply',
    AgentConversationReplyPayload
>({
    id: 'agent-conversation-reply',
    maxDuration: 300,
    onFailure: async ({ payload, error }) => {
        if (!payload?.runId) return;
        assertUuid(payload.runId, 'payload.runId');
        try {
            const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
            appContext.useLogger(createTriggerLogger('AgentConversationReply:Failure'));
            try {
                const runs = appContext.get(AgentRunRepository);
                const run = await runs.findById(payload.runId);
                if (run && (run.status === 'queued' || run.status === 'running')) {
                    await runs.markFailed(
                        run.id,
                        error instanceof Error ? error.message : String(error),
                    );
                }
            } finally {
                await appContext.close();
            }
        } catch {
            // Best-effort — the stuck-run sweeper recovers the row.
        }
    },
    run: async (
        payload: AgentConversationReplyPayload,
        // `signal` is deliberately not destructured — see the note in
        // `agent-chat-reply.task.ts`: `AgentRunService` is a remote proxy here.
        { ctx }: { ctx?: { run?: { id?: string } }; signal?: AbortSignal } = {},
    ) => {
        assertUuid(payload.agentId, 'payload.agentId');
        assertUuid(payload.userId, 'payload.userId');
        assertUuid(payload.conversationId, 'payload.conversationId');
        assertUuid(payload.triggeringMessageId, 'payload.triggeringMessageId');
        if (payload.runId) assertUuid(payload.runId, 'payload.runId');

        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('AgentConversationReply'));

        try {
            const agents = appContext.get(AgentRepository);
            const runs = appContext.get(AgentRunRepository);
            const runner = appContext.get(AgentRunService);
            const messages = appContext.get(ConversationMessageService);

            const agent = await agents.findByIdAndUser(payload.agentId, payload.userId);
            if (!agent) {
                return { status: 'skipped', reason: 'agent-not-found-or-forbidden' };
            }

            let run = payload.runId ? await runs.findById(payload.runId) : null;
            if (
                run &&
                (run.agentId !== agent.id ||
                    run.conversationMessageId !== payload.triggeringMessageId)
            ) {
                return { status: 'skipped', reason: 'run-payload-mismatch' };
            }
            if (run && run.status !== 'queued' && run.status !== 'running') {
                return { status: 'skipped', reason: `run-${run.status}`, runId: run.id };
            }
            if (!run) {
                // DOCUMENTED dispatch-gate bypass, same as the chat reply job:
                // bookkeeping for a job the runtime already accepted.
                run = await runs.createQueued({
                    agentId: agent.id,
                    userId: payload.userId,
                    triggerKind: 'conversation',
                    conversationMessageId: payload.triggeringMessageId,
                });
            }

            const claimed = await runs.markStarted(run.id, ctx?.run?.id ?? null);
            if (!claimed) {
                return { status: 'skipped', reason: 'run-already-terminal', runId: run.id };
            }

            const context = await messages.loadReplyContext(
                payload.userId,
                payload.conversationId,
                payload.triggeringMessageId,
            );
            if (!context || !context.triggering) {
                await runs.markFailed(run.id, 'Conversation or message not found');
                return { status: 'skipped', reason: 'conversation-not-found', runId: run.id };
            }

            const immediateInput = await messages.agentVisibleBody(
                payload.userId,
                context.triggering.content,
            );
            const conversationContext = context.recent.map((message) => ({
                author: `${message.authorType ?? 'user'}:${message.authorId ?? message.role}`,
                body: message.content,
                createdAt:
                    typeof message.createdAt === 'string'
                        ? message.createdAt
                        : (message.createdAt?.toISOString?.() ?? undefined),
            }));
            const about =
                context.conversation.contextType && context.conversation.contextId
                    ? `About: ${context.conversation.contextType} ${context.conversation.contextId}`
                    : null;
            const scopeContext = [
                `Conversation${context.conversation.title ? `: ${context.conversation.title}` : ''}`,
                about,
            ]
                .filter(Boolean)
                .join('\n');

            const result = await runner.execute({
                runId: run.id,
                agentId: agent.id,
                userId: payload.userId,
                // The chat protocol: the model answers in natural language and
                // the reply body is parsed from it.
                kind: 'chat',
                conversationMessageId: payload.triggeringMessageId,
                immediateInput,
                conversationContext,
                scopeContext,
            });

            if (result.status === 'assembled') {
                await runs.markCompleted(
                    run.id,
                    `Prompt assembled for conversation message ${payload.triggeringMessageId}`,
                );
            } else if (result.status === 'agent-not-found') {
                await runs.markFailed(run.id, 'Agent not found');
            } else if (result.status === 'budget-blocked' || result.status === 'dispatch-failed') {
                // The runner already failed the run — the budget refused it, or
                // the model call errored. Without this the person would see
                // nothing: their message moves to `failed` with the reason, so
                // the Conversation can say why and offer Retry.
                await messages.markReplyRefused({
                    conversationId: payload.conversationId,
                    messageId: payload.triggeringMessageId,
                    failureCode:
                        result.status === 'budget-blocked'
                            ? 'budget_exceeded'
                            : 'provider_unavailable',
                });
            }

            const reply = result.outcome?.replyBody?.trim();
            let replyMessageId: string | undefined;
            if (reply && result.status === 'dispatched') {
                const stored = await messages.appendAgentMessage({
                    conversationId: payload.conversationId,
                    agentId: agent.id,
                    body: reply,
                    replyToMessageId: payload.triggeringMessageId,
                });
                replyMessageId = stored.id;
            }

            return {
                status:
                    result.status === 'assembled' || result.status === 'dispatched'
                        ? 'completed'
                        : result.status,
                agentId: agent.id,
                conversationId: payload.conversationId,
                triggeringMessageId: payload.triggeringMessageId,
                replyMessageId,
                runId: run.id,
                dedupKey: payload.dedupKey,
            };
        } finally {
            await appContext.close();
        }
    },
});
