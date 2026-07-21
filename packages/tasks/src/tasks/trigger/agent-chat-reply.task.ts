import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { AgentRunService } from '@ever-works/agent/agents';
import { TaskChatService, TasksService } from '@ever-works/agent/tasks-domain';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
// Security: import assertUuid to validate Trigger.dev payload fields before any DB access
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';

export interface AgentChatReplyPayload {
    agentId: string;
    userId: string;
    taskId: string;
    runId?: string;
    /** The originating chat message id (lets the worker fetch full thread context). */
    triggeringMessageId: string;
    /** Dedup key — `${taskId}:${agentId}:${triggeringMessageId}`. */
    dedupKey: string;
}

/**
 * Tasks feature — Phase 15.2.
 *
 * One-shot Trigger.dev task that dispatches an Agent's reply to a
 * Task chat thread. Triggered by `TaskChatService.post` when the
 * message body contains an `@<agent-slug>` mention resolved to one
 * of the user's Agents.
 *
 * `findInFlightForTaskAgent` is the chat-dedup guard from
 * `architecture/security-agents-skills-tasks.md §8 (T6)`: if a
 * chat-triggered run is already running for the same (task, agent)
 * pair, this run appends context to the in-flight run rather than
 * spawning a second one.
 *
 * v1 marks the in-flight (or freshly created) AgentRun started +
 * completed with a stub summary. AgentRunService kind='chat' wires
 * the real LLM dispatch + post-back-to-chat next.
 *
 * maxDuration = 5min per `features/task-tracking/plan.md §15`.
 */
export const agentChatReplyTask = task<'agent-chat-reply', AgentChatReplyPayload>({
    id: 'agent-chat-reply',
    maxDuration: 300,
    onFailure: async ({ payload, error }) => {
        if (!payload) return;
        // Security: validate payload IDs before any DB access (defense-in-depth, mirrors agent-heartbeat)
        assertUuid(payload.agentId, 'payload.agentId');
        assertUuid(payload.userId, 'payload.userId');
        assertUuid(payload.taskId, 'payload.taskId');
        try {
            const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
            appContext.useLogger(createTriggerLogger('AgentChatReply:Failure'));
            try {
                const runs = appContext.get(AgentRunRepository);
                const message = error instanceof Error ? error.message : String(error);
                const inFlight = payload.runId
                    ? await runs.findById(payload.runId)
                    : await runs.findInFlightForTaskAgent(payload.taskId, payload.agentId);
                if (inFlight && (inFlight.status === 'queued' || inFlight.status === 'running')) {
                    await runs.markFailed(inFlight.id, message);
                }
            } finally {
                await appContext.close();
            }
        } catch {
            // Best-effort — stuck-row sweep will recover.
        }
    },
    run: async (
        payload: AgentChatReplyPayload,
        // NOTE: this annotation replaces the SDK RunFnParams, so anything omitted
        // here is silently invisible — which is exactly how `signal` went unused.
        { ctx, signal }: { ctx?: { run?: { id?: string } }; signal?: AbortSignal } = {},
    ) => {
        // Security: validate payload IDs before any DB access (defense-in-depth, mirrors agent-heartbeat).
        // triggeringMessageId is also asserted: it is a TaskChatMessage uuid PK and its raw value
        // flows into the prompt fallback (`Chat message ${...}`) and the AgentRun row.
        assertUuid(payload.agentId, 'payload.agentId');
        assertUuid(payload.userId, 'payload.userId');
        assertUuid(payload.taskId, 'payload.taskId');
        assertUuid(payload.triggeringMessageId, 'payload.triggeringMessageId');
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('AgentChatReply'));

        try {
            const agents = appContext.get(AgentRepository);
            const runs = appContext.get(AgentRunRepository);
            const runner = appContext.get(AgentRunService);
            const tasks = appContext.get(TasksService);
            const chat = appContext.get(TaskChatService);

            const agent = await agents.findByIdAndUser(payload.agentId, payload.userId);
            if (!agent) {
                return {
                    status: 'skipped',
                    reason: 'agent-not-found-or-forbidden',
                    agentId: payload.agentId,
                };
            }

            // T6 chat-dedup: re-use any in-flight (task, agent) run.
            let run = payload.runId ? await runs.findById(payload.runId) : null;
            if (
                run &&
                (run.agentId !== agent.id ||
                    run.taskId !== payload.taskId ||
                    run.chatMessageId !== payload.triggeringMessageId)
            ) {
                return {
                    status: 'skipped',
                    reason: 'run-payload-mismatch',
                    agentId: payload.agentId,
                };
            }
            if (run && run.status !== 'queued' && run.status !== 'running') {
                return {
                    status: 'skipped',
                    reason: `run-${run.status}`,
                    agentId: agent.id,
                    taskId: payload.taskId,
                    triggeringMessageId: payload.triggeringMessageId,
                    runId: run.id,
                    dedupKey: payload.dedupKey,
                };
            }
            if (!run) {
                run = await runs.findInFlightForTaskAgent(payload.taskId, payload.agentId);
            }
            if (!run) {
                // Security: stamp the run with the dispatch-asserted `payload.userId`
                // (the user who actually triggered the chat reply), not the looked-up
                // `agent.userId` (the agent's DB owner). For legitimate mentions these
                // are equal, but using payload.userId keeps this fallback row consistent
                // with the dispatcher's pre-created row and avoids attributing the run to
                // a different owner should the lookup ever resolve a foreign agent.
                run = await runs.createQueued({
                    agentId: agent.id,
                    userId: payload.userId,
                    triggerKind: 'chat',
                    taskId: payload.taskId,
                    chatMessageId: payload.triggeringMessageId,
                });
            }

            await runs.markStarted(run.id, ctx?.run?.id ?? null);

            const [taskRow, messages] = await Promise.all([
                tasks.getOne(payload.userId, payload.taskId).catch(() => null),
                chat.list(payload.userId, payload.taskId, { limit: 20, offset: 0 }).catch(() => []),
            ]);
            const orderedMessages = [...messages].reverse();
            const triggering = orderedMessages.find((m) => m.id === payload.triggeringMessageId);
            const conversationContext = orderedMessages.map((m) => ({
                author: `${m.authorType}:${m.authorId}`,
                body: m.body,
                createdAt:
                    typeof m.createdAt === 'string'
                        ? m.createdAt
                        : (m.createdAt?.toISOString?.() ?? undefined),
            }));
            const immediateInput =
                triggering?.body ?? `Chat message ${payload.triggeringMessageId}`;

            const result = await runner.execute({
                runId: run.id,
                agentId: agent.id,
                userId: payload.userId,
                kind: 'chat',
                signal,
                taskId: payload.taskId,
                chatMessageId: payload.triggeringMessageId,
                immediateInput,
                conversationContext,
                scopeContext: taskRow
                    ? `Task ${taskRow.slug ?? taskRow.id}: ${taskRow.title}\nStatus: ${taskRow.status}\nPriority: ${taskRow.priority}`
                    : null,
            });

            if (result.status === 'assembled') {
                await runs.markCompleted(
                    run.id,
                    `Prompt assembled for chat message ${payload.triggeringMessageId}`,
                );
            } else if (result.status === 'agent-not-found') {
                await runs.markFailed(run.id, 'Agent not found');
            }

            return {
                status:
                    result.status === 'assembled' || result.status === 'dispatched'
                        ? 'completed'
                        : result.status,
                agentId: agent.id,
                taskId: payload.taskId,
                triggeringMessageId: payload.triggeringMessageId,
                runId: run.id,
                dedupKey: payload.dedupKey,
            };
        } finally {
            await appContext.close();
        }
    },
});
