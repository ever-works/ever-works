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
import { TaskTemplate } from '../entities/task-template.entity';
import { TaskTemplateStep } from '../entities/task-template-step.entity';
import { UserTaskCounter } from '../entities/user-task-counter.entity';
import { WorkKnowledgeUpload } from '../entities/work-knowledge-upload.entity';
import { Work } from '../entities/work.entity';
import { Mission } from '../entities/mission.entity';
import { Team } from '../entities/team.entity';
import { Goal } from '../entities/goal.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { TaskTemplateRepository } from '../database/repositories/task-template.repository';
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
import { TaskTemplatesService } from './task-templates.service';
import { TaskChatService } from './task-chat.service';
import { TaskGateRunnerService } from './task-gate-runner.service';
import { TaskGateJudgeService } from './task-gate-judge.service';
import { TaskRecurrenceDispatcherService } from './task-recurrence-dispatcher.service';
import { TaskNotificationService } from './task-notification.service';
import { TaskRunDenormService } from './task-run-denorm.service';
import { TaskReviewRejectionService } from './task-review-rejection.service';
import { TaskGitLinkService } from './task-git-link.service';
import { TaskWorkspaceService } from './task-workspace.service';
import { TaskPrStatusService } from './task-pr-status.service';
import { FacadesModule } from '../facades/facades.module';
import { PolicyModule } from '../policy/policy.module';
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
            // Tasks upgrades — workflow templates. ALSO registered in
            // `_entities-inventory.ts` (no autoLoadEntities in this repo).
            TaskTemplate,
            TaskTemplateStep,
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
        // Wave 2 M3 — TaskWorkspaceService resolves + provisions the
        // per-Task isolated workspace through the workspace/git facades.
        FacadesModule,
        // Wave 3 D4 — TaskWorkspaceService.finalizeRun records the scope
        // that governs this Work's merges in its PR-opened log line.
        PolicyModule,
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
        // Tasks upgrades — workflow-template store + CRUD/instantiation.
        TaskTemplateRepository,
        TaskTransitionService,
        TasksService,
        TaskTemplatesService,
        TaskChatService,
        TaskRecurrenceDispatcherService,
        TaskNotificationService,
        TaskRunDenormService,
        TaskWorkspaceService,
        // Orchestration M9 - the write half of the rejection loop. Reads
        // TaskReviewRejectionRepository, which AgentsModule (imported
        // above) owns and exports alongside AgentRunRepository.
        TaskReviewRejectionService,
        // Git activity ingestion (audit item j) — read-only branch/PR →
        // Task resolver the GitHub receiver stamps onto push / commit /
        // merge events. Reads TaskRepository + WorkRepository, both
        // already provided above.
        TaskGitLinkService,
        // Kanban run cockpit (plan 04 M5/M6) — PR status cache + capped
        // diff reads. Uses the git facade (FacadesModule, imported above)
        // and TaskTransitionService for the merged-PR -> done landing.
        TaskPrStatusService,
        // Wave 3 M2 — acceptance-check runner (quality gates). Needs only
        // AgentRunRepository (exported by AgentsModule above) to persist
        // per-run gate results.
        TaskGateRunnerService,
        // Judgment layer G2 — the LLM-vs-criteria judge that turns a green
        // gate into pass/retry/escalate. Consumes AiFacadeService only
        // (FacadesModule, imported above) and treats it as @Optional(), so
        // a deployment with no AI provider degrades to "no judge".
        TaskGateJudgeService,
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
        TaskTemplateRepository,
        TaskTransitionService,
        TasksService,
        TaskTemplatesService,
        TaskChatService,
        TaskRecurrenceDispatcherService,
        TaskNotificationService,
        TaskRunDenormService,
        TaskWorkspaceService,
        TaskReviewRejectionService,
        TaskGitLinkService,
        TaskPrStatusService,
        TaskGateRunnerService,
        TaskGateJudgeService,
    ],
})
export class TasksDomainModule {}
