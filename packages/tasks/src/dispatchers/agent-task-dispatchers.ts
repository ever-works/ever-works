import { tasks } from '@trigger.dev/sdk';
import type {
	AgentChatReplyDispatcher,
	AgentChatReplyDispatchPayload,
	AgentTaskExecuteDispatcher,
	AgentTaskExecuteDispatchPayload,
} from '@ever-works/agent/tasks-domain';
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
export const agentTaskExecuteTriggerAdapter: AgentTaskExecuteDispatcher = {
	async enqueue(payload: AgentTaskExecuteDispatchPayload) {
		const handle = await tasks.trigger<typeof import('../tasks/trigger/agent-task-execute.task').agentTaskExecuteTask>(
			'agent-task-execute',
			{
				agentId: payload.agentId,
				userId: payload.userId,
				taskId: payload.taskId,
				dedupKey: payload.dedupKey,
			} satisfies AgentTaskExecutePayload,
		);
		return { runId: handle.id };
	},
};

export const agentChatReplyTriggerAdapter: AgentChatReplyDispatcher = {
	async enqueue(payload: AgentChatReplyDispatchPayload) {
		const handle = await tasks.trigger<typeof import('../tasks/trigger/agent-chat-reply.task').agentChatReplyTask>(
			'agent-chat-reply',
			{
				agentId: payload.agentId,
				userId: payload.userId,
				taskId: payload.taskId,
				triggeringMessageId: payload.triggeringMessageId,
				dedupKey: payload.dedupKey,
			} satisfies AgentChatReplyPayload,
		);
		return { runId: handle.id };
	},
};
