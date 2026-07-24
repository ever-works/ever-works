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
import { WorkKnowledgeUpload } from '../entities/work-knowledge-upload.entity';
import { Work } from '../entities/work.entity';
import { Mission } from '../entities/mission.entity';
import { Team } from '../entities/team.entity';
import { Goal } from '../entities/goal.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
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
import { TaskTransitionService } from './task-transition.service';
import { TasksService } from './tasks.service';
import { TaskChatService } from './task-chat.service';
import { TaskRecurrenceDispatcherService } from './task-recurrence-dispatcher.service';
import { TaskNotificationService } from './task-notification.service';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AgentsModule } from '../agents/agents.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Tasks feature — Phases 11 + 12 + 13.
 *
 * Agent-side module that owns the Tasks family data surface +
 * the service layer (TasksService + TaskTransitionService +
 * TaskChatService).
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
            WorkKnowledgeUpload,
            Work,
            Mission,
            WorkProposal,
            // Owner-reachability checks for the Team / Goal task owners.
            // These MUST also be present in the DataSource ENTITIES array
            // (`packages/agent/src/database/database.config.ts`) — this repo
            // has no `autoLoadEntities`, so a forFeature'd-but-unregistered
            // entity throws EntityMetadataNotFoundError on first query.
            Team,
            Goal,
        ]),
        ActivityLogModule,
        // Phase 15 — TaskTransitionService + TaskChatService consume
        // AgentRunRepository to pre-create queued AgentRun rows before
        // fanning out the agent-task-execute / agent-chat-reply
        // Trigger.dev runs. AgentsModule exports AgentRunRepository.
        AgentsModule,
        // Phase 18.4 — TaskNotificationService wraps
        // NotificationService.create() for the new TASK category.
        NotificationsModule,
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
        WorkKnowledgeUploadRepository,
        WorkRepository,
        WorkProposalRepository,
        TaskTransitionService,
        TasksService,
        TaskChatService,
        TaskRecurrenceDispatcherService,
        TaskNotificationService,
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
        WorkKnowledgeUploadRepository,
        WorkRepository,
        WorkProposalRepository,
        TaskTransitionService,
        TasksService,
        TaskChatService,
        TaskRecurrenceDispatcherService,
        TaskNotificationService,
    ],
})
export class TasksDomainModule {}
