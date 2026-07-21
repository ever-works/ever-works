import { tasks } from '@trigger.dev/sdk';
import type {
    AgentHeartbeatTrigger,
    AgentRunCanceller,
    AgentRunCancelOutcome,
} from '@ever-works/agent/agents';
import type { TriggerService } from '../trigger/trigger.service';
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

/**
 * Cancels the Trigger.dev run behind an AgentRun. Bound to
 * `AGENT_RUN_CANCELLER` in the API-side `AgentsModule`.
 *
 * A factory rather than a `useValue` literal because it delegates to the
 * injectable `TriggerService` instead of calling `runs.cancel` directly. That
 * matters for two reasons: `TriggerService.cancel` already try/catches and
 * logs, so the port's never-throw contract holds without a third copy of that
 * body; and its `isEnabled()` gate lets us report "Trigger.dev is off" as a
 * distinct outcome rather than folding a misconfiguration into the same signal
 * as a benign already-terminal run.
 *
 * Unlike the stateless adapters above, this never touches the SDK directly, so
 * it does not inherit their implicit "someone constructed TriggerService first"
 * ordering dependency.
 */
export const createAgentRunCancellerAdapter = (trigger: TriggerService): AgentRunCanceller => ({
    async cancel(triggerRunId: string): Promise<AgentRunCancelOutcome> {
        if (!trigger.isEnabled()) return 'not-configured';
        return (await trigger.cancel(triggerRunId)) ? 'cancelled' : 'failed';
    },
});
