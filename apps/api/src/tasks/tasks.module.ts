import { Module } from '@nestjs/common';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { TasksController } from './tasks.controller';
import { TaskChatController } from './task-chat.controller';

/**
 * Tasks feature — Phases 12 + 13. API-side module. Imports the
 * agent-side data module (which carries TasksService +
 * TaskTransitionService + TaskChatService) and mounts both
 * controllers:
 *
 *   - TasksController         — /api/tasks/* (CRUD + transitions +
 *                               members + per-task chat list + post)
 *   - TaskChatController      — PATCH /api/task-chat-messages/:id
 *                               (5-min edit window)
 */
@Module({
	imports: [TasksDomainModule],
	controllers: [TasksController, TaskChatController],
})
export class TasksModule {}
