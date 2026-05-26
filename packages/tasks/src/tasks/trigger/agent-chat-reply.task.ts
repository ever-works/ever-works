import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

export interface AgentChatReplyPayload {
    agentId: string;
    userId: string;
    taskId: string;
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
        try {
            const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
            appContext.useLogger(createTriggerLogger('AgentChatReply:Failure'));
            try {
                const runs = appContext.get(AgentRunRepository);
                const message = error instanceof Error ? error.message : String(error);
                const inFlight = await runs.findInFlightForTaskAgent(
                    payload.taskId,
                    payload.agentId,
                );
                if (inFlight) {
                    await runs.markFailed(inFlight.id, message);
                }
            } finally {
                await appContext.close();
            }
        } catch {
            // Best-effort — stuck-row sweep will recover.
        }
    },
    run: async (payload: AgentChatReplyPayload) => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('AgentChatReply'));

        try {
            const agents = appContext.get(AgentRepository);
            const runs = appContext.get(AgentRunRepository);

            const agent = await agents.findById(payload.agentId);
            if (!agent) {
                return { status: 'skipped', reason: 'agent-not-found', agentId: payload.agentId };
            }

            // T6 chat-dedup: re-use any in-flight (task, agent) run.
            let run = await runs.findInFlightForTaskAgent(payload.taskId, payload.agentId);
            if (!run) {
                run = await runs.createQueued({
                    agentId: agent.id,
                    userId: agent.userId,
                    triggerKind: 'chat',
                    taskId: payload.taskId,
                    chatMessageId: payload.triggeringMessageId,
                });
            }

            await runs.markStarted(run.id, null);

            // Phase 15 placeholder — AgentRunService.execute({kind:'chat'})
            // wires LLM + post-back-to-chat. v1 just records completion.
            const summary = `Phase 15 placeholder — chat reply for task ${payload.taskId}, msg ${payload.triggeringMessageId}`;
            await runs.markCompleted(run.id, summary);

            return {
                status: 'completed',
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
