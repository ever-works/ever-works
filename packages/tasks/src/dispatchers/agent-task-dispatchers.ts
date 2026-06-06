import { tasks } from '@trigger.dev/sdk';
import type { AgentHeartbeatTrigger } from '@ever-works/agent/agents';
import type {
    AgentChatReplyDispatcher,
    AgentChatReplyDispatchPayload,
    AgentTaskExecuteDispatcher,
    AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
import type { AgentHeartbeatPayload } from '../tasks/trigger/agent-heartbeat.task';
import type { AgentChatReplyPayload } from '../tasks/trigger/agent-chat-reply.task';
import type { AgentTaskExecutePayload } from '../tasks/trigger/agent-task-execute.task';

/**
 * Tasks feature — Phase 15.3 + 15.4. Production dispatcher adapters
 * that fan out platform `TaskTransitionService` / `TaskChatService`
 * events to the Trigger.dev `agent-task-execute` / `agent-chat-reply`
 * tasks.
 *
 * Wired into the API-side `TasksModule` via useFactory bindings on
 * the dispatcher tokens — keeps `@trigger.dev/sdk` out of the
 * @ever-works/agent package's dependency graph.
 */
export const agentHeartbeatTriggerAdapter: AgentHeartbeatTrigger = {
    async enqueue(payload) {
        const handle = await tasks.trigger<
            typeof import('../tasks/trigger/agent-heartbeat.task').agentHeartbeatTask
        >('agent-heartbeat', {
            agentId: payload.agentId,
            userId: payload.userId,
            runId: payload.runId,
            scheduledFor: payload.scheduledFor.toISOString(),
        } satisfies AgentHeartbeatPayload);
        return { runId: handle.id };
    },
};

export const agentTaskExecuteTriggerAdapter: AgentTaskExecuteDispatcher = {
    async enqueue(payload: AgentTaskExecuteDispatchPayload) {
        // Review-fix I10: pass `idempotencyKey` to Trigger.dev so a
        // double-fire for the same (taskId, agentId, generation) tuple
        // is deduped at the runner. Previously `dedupKey` rode only as
        // payload data; without `idempotencyKey` Trigger.dev would
        // happily spawn two runs for the same logical trigger.
        const handle = await tasks.trigger<
            typeof import('../tasks/trigger/agent-task-execute.task').agentTaskExecuteTask
        >(
            'agent-task-execute',
            {
                agentId: payload.agentId,
                userId: payload.userId,
                taskId: payload.taskId,
                dedupKey: payload.dedupKey,
                runId: payload.runId,
            } satisfies AgentTaskExecutePayload,
            { idempotencyKey: payload.dedupKey },
        );
        return { runId: handle.id };
    },
};

export const agentChatReplyTriggerAdapter: AgentChatReplyDispatcher = {
    async enqueue(payload: AgentChatReplyDispatchPayload) {
        // Review-fix I10 (mirror of agent-task-execute adapter above).
        const handle = await tasks.trigger<
            typeof import('../tasks/trigger/agent-chat-reply.task').agentChatReplyTask
        >(
            'agent-chat-reply',
            {
                agentId: payload.agentId,
                userId: payload.userId,
                taskId: payload.taskId,
                triggeringMessageId: payload.triggeringMessageId,
                dedupKey: payload.dedupKey,
                runId: payload.runId,
            } satisfies AgentChatReplyPayload,
            { idempotencyKey: payload.dedupKey },
        );
        return { runId: handle.id };
    },
};
