// Public surface of the agent-side Tasks domain module
// (Agents/Skills/Tasks PR #1017 — Phase 11). Distinct from
// `@ever-works/agent/tasks` which is the Trigger.dev jobs subpath
// — this module owns the per-Task DB entities + repositories.
export * from './tasks.module';
export * from './tasks.service';
export * from './task-transition.service';
export * from './task-chat.service';
export * from './task-dispatcher';
export {
	Task,
	TaskPriority,
	TaskStatus,
	type TaskActorType,
} from '../entities/task.entity';
export { TaskAssignee } from '../entities/task-assignee.entity';
export { TaskReviewer, type TaskReviewState } from '../entities/task-reviewer.entity';
export { TaskApprover, type TaskApprovalState } from '../entities/task-approver.entity';
export { TaskBlock } from '../entities/task-block.entity';
export { TaskRelation, type TaskRelationKind } from '../entities/task-relation.entity';
export {
	TaskChatMessage,
	type TaskChatMention,
	type TaskChatAttachmentRef,
} from '../entities/task-chat-message.entity';
export { TaskAttachment } from '../entities/task-attachment.entity';
export { TaskWatcher } from '../entities/task-watcher.entity';
export { TaskKbMention } from '../entities/task-kb-mention.entity';
export { UserTaskCounter } from '../entities/user-task-counter.entity';
export {
	TaskRepository,
	type ListTasksFilter,
} from '../database/repositories/task.repository';
export {
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
