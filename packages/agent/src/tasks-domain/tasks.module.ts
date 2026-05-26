import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from '../entities/task.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskReviewer } from '../entities/task-reviewer.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskBlock } from '../entities/task-block.entity';
import { TaskRelation } from '../entities/task-relation.entity';
import { TaskChatMessage } from '../entities/task-chat-message.entity';
import { TaskAttachment } from '../entities/task-attachment.entity';
import { TaskWatcher } from '../entities/task-watcher.entity';
import { TaskKbMention } from '../entities/task-kb-mention.entity';
import { UserTaskCounter } from '../entities/user-task-counter.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import {
	TaskAssigneeRepository,
	TaskReviewerRepository,
	TaskApproverRepository,
	TaskBlockRepository,
	TaskRelationRepository,
	TaskChatMessageRepository,
	TaskAttachmentRepository,
	TaskWatcherRepository,
	TaskKbMentionRepository,
	UserTaskCounterRepository,
} from '../database/repositories/task-side.repositories';

/**
 * Tasks feature — Phase 11.
 *
 * Agent-side module that owns the Tasks family data surface.
 * Service layer (TasksService, TaskTransitionService, TaskChatService)
 * lands in Phase 12. The "Ever Works Task Tracker" plugin binds to
 * this module's `TaskRepository` via the platform's plugin bootstrap.
 *
 * Module is named `tasks-domain` on disk (and not `tasks`) to avoid
 * confusion with `packages/tasks/` which is the Trigger.dev jobs
 * package — they're orthogonal concerns sharing the same word.
 */
@Module({
	imports: [
		TypeOrmModule.forFeature([
			Task,
			TaskAssignee,
			TaskReviewer,
			TaskApprover,
			TaskBlock,
			TaskRelation,
			TaskChatMessage,
			TaskAttachment,
			TaskWatcher,
			TaskKbMention,
			UserTaskCounter,
		]),
	],
	providers: [
		TaskRepository,
		TaskAssigneeRepository,
		TaskReviewerRepository,
		TaskApproverRepository,
		TaskBlockRepository,
		TaskRelationRepository,
		TaskChatMessageRepository,
		TaskAttachmentRepository,
		TaskWatcherRepository,
		TaskKbMentionRepository,
		UserTaskCounterRepository,
	],
	exports: [
		TaskRepository,
		TaskAssigneeRepository,
		TaskReviewerRepository,
		TaskApproverRepository,
		TaskBlockRepository,
		TaskRelationRepository,
		TaskChatMessageRepository,
		TaskAttachmentRepository,
		TaskWatcherRepository,
		TaskKbMentionRepository,
		UserTaskCounterRepository,
	],
})
export class TasksDomainModule {}
