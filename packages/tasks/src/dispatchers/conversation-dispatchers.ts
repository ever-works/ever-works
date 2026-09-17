import { tasks } from '@trigger.dev/sdk';
import { config } from '@ever-works/agent/config';
import { JobRuntimeNotConfiguredError } from '@ever-works/agent/tasks-domain';
import type {
    AgentConversationReplyDispatcher,
    AgentConversationReplyDispatchPayload,
} from '@ever-works/agent/conversations';
import type { AgentConversationReplyPayload } from '../tasks/trigger/agent-conversation-reply.task';

/**
 * Loud degradation, the same gate as `agent-task-dispatchers.ts`: an install
 * with no usable job runtime throws a typed, stably-named error instead of
 * failing inside the SDK with an opaque network error. The dispatch service
 * turns it into a `refused — job-runtime-not-configured` reach entry.
 */
function assertJobRuntimeConfigured(): void {
    if (!config.trigger.shouldUseTrigger() || !config.trigger.getSecretKey()) {
        throw new JobRuntimeNotConfiguredError();
    }
}

/**
 * Named Conversations — production adapter behind
 * `AGENT_CONVERSATION_REPLY_DISPATCHER`, bound by the api-side `TasksModule`
 * next to the Task chat adapter. Keeps the job-runtime SDK out of
 * `@ever-works/agent`.
 */
export const agentConversationReplyTriggerAdapter: AgentConversationReplyDispatcher = {
    async enqueue(payload: AgentConversationReplyDispatchPayload) {
        assertJobRuntimeConfigured();
        const handle = await tasks.trigger<
            typeof import('../tasks/trigger/agent-conversation-reply.task').agentConversationReplyTask
        >(
            'agent-conversation-reply',
            {
                agentId: payload.agentId,
                userId: payload.userId,
                conversationId: payload.conversationId,
                triggeringMessageId: payload.triggeringMessageId,
                dedupKey: payload.dedupKey,
                runId: payload.runId,
            } satisfies AgentConversationReplyPayload,
            { idempotencyKey: payload.dedupKey },
        );
        return { runId: handle.id };
    },
};
