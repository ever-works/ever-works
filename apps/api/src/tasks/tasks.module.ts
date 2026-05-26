import { Module } from '@nestjs/common';
import {
	TasksDomainModule,
	AGENT_TASK_EXECUTE_DISPATCHER,
	AGENT_CHAT_REPLY_DISPATCHER,
} from '@ever-works/agent/tasks-domain';
import { DatabaseModule } from '@ever-works/agent/database';
import {
	agentTaskExecuteTriggerAdapter,
	agentChatReplyTriggerAdapter,
} from '@ever-works/trigger-tasks';
import { TasksController } from './tasks.controller';
import { TaskChatController } from './task-chat.controller';

/**
 * Tasks feature — Phases 12 + 13 + 15. API-side module.
 *
 *   - TasksDomainModule   — TasksService + TaskTransitionService +
 *                           TaskChatService + repositories
 *   - DatabaseModule      — PluginUsageRepository for the Phase-15
 *                           per-Task spend rollup endpoint
 *   - dispatcher tokens   — bind the production Trigger.dev adapters
 *                           so * → in_progress and @agent chat
 *                           mentions fan out to agent-task-execute /
 *                           agent-chat-reply runs.
 */
@Module({
	imports: [TasksDomainModule, DatabaseModule],
	controllers: [TasksController, TaskChatController],
	providers: [
		{ provide: AGENT_TASK_EXECUTE_DISPATCHER, useValue: agentTaskExecuteTriggerAdapter },
		{ provide: AGENT_CHAT_REPLY_DISPATCHER, useValue: agentChatReplyTriggerAdapter },
	],
	exports: [AGENT_TASK_EXECUTE_DISPATCHER, AGENT_CHAT_REPLY_DISPATCHER],
})
export class TasksModule {}
