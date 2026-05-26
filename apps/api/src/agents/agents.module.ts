import { Module } from '@nestjs/common';
import {
	AgentsModule as AgentAgentsModule,
	AGENT_RUN_CHAT_BACK_POSTER,
	AGENT_RUN_TASK_FINISHER,
	type AgentRunChatBackPoster,
	type AgentRunTaskFinisher,
} from '@ever-works/agent/agents';
import {
	TasksDomainModule,
	TaskChatService,
	TasksService,
	TaskStatus,
} from '@ever-works/agent/tasks-domain';
import { AuthModule } from '../auth/auth.module';
import { AgentsController } from './agents.controller';

/**
 * Agents/Skills/Tasks PR #1017 — api-side AgentsModule (Phase 3 + 15.5).
 *
 * Mounts the AgentsController; defers to the agent-side AgentsModule
 * for the service + repositories + entities.
 *
 * Phase 15.5: binds the `chat-back poster` + `task finisher`
 * post-processor tokens to platform services so
 * `AgentRunService.finalize()` can route auto-replies through
 * `TaskChatService.post(authorType='agent')` and status flips
 * through `TasksService.transition()`. Same posture as
 * `TasksModule` binding the `agent-task-execute` /
 * `agent-chat-reply` dispatcher tokens (Phase 15.3 / 15.4) —
 * keeps the agent package free of a hard `@ever-works/agent/tasks-domain`
 * runtime dependency at the AgentsModule layer.
 */
@Module({
	imports: [AgentAgentsModule, TasksDomainModule, AuthModule],
	controllers: [AgentsController],
	providers: [
		{
			provide: AGENT_RUN_CHAT_BACK_POSTER,
			inject: [TaskChatService],
			useFactory: (chat: TaskChatService): AgentRunChatBackPoster => ({
				async postReply({ userId, taskId, agentId, body }) {
					const row = await chat.post(userId, {
						taskId,
						authorType: 'agent',
						authorId: agentId,
						body,
					});
					return { messageId: row.id };
				},
			}),
		},
		{
			provide: AGENT_RUN_TASK_FINISHER,
			inject: [TasksService],
			useFactory: (tasks: TasksService): AgentRunTaskFinisher => ({
				async finishTask({ userId, taskId, to, force }) {
					const row = await tasks.transition(userId, taskId, to as TaskStatus, {
						force: force ?? false,
					});
					return { status: row.status };
				},
			}),
		},
	],
	exports: [AGENT_RUN_CHAT_BACK_POSTER, AGENT_RUN_TASK_FINISHER],
})
export class AgentsModule {}
