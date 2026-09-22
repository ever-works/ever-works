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
import { TaskCiAutoResumeAttempt } from '../entities/task-ci-auto-resume-attempt.entity';
import { TaskAgentReview } from '../entities/task-agent-review.entity';
import { UserTaskCounter } from '../entities/user-task-counter.entity';
import { WorkKnowledgeUpload } from '../entities/work-knowledge-upload.entity';
import { AgentRepoAttachment } from '../entities/agent-repo-attachment.entity';
import { Work } from '../entities/work.entity';
import { Mission } from '../entities/mission.entity';
import { Team } from '../entities/team.entity';
import { Goal } from '../entities/goal.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { TaskCiAutoResumeAttemptRepository } from '../database/repositories/task-ci-auto-resume-attempt.repository';
import { TaskAgentReviewRepository } from '../database/repositories/task-agent-review.repository';
import { AgentRepoAttachmentRepository } from '../database/repositories/agent-repo-attachment.repository';
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
import { TaskBoardService } from './task-board.service';
import { TaskTemplatesService } from './task-templates.service';
import { TaskChatService } from './task-chat.service';
import { TaskGateRunnerService } from './task-gate-runner.service';
import { TaskGateJudgeService } from './task-gate-judge.service';
import { TaskRecurrenceDispatcherService } from './task-recurrence-dispatcher.service';
import { TaskGraphFanoutService } from './task-graph-fanout.service';
import { TaskNotificationService } from './task-notification.service';
import { TaskRunDenormService } from './task-run-denorm.service';
import { TaskReviewRejectionService } from './task-review-rejection.service';
import { TaskReviewApprovalService } from './task-review-approval.service';
import { TaskMergeGateService } from './task-merge-gate.service';
import { TaskGitLinkService } from './task-git-link.service';
import { TaskWorkspaceService } from './task-workspace.service';
import { TaskPrStatusService } from './task-pr-status.service';
import { TaskCiAutoResumeService } from './task-ci-auto-resume.service';
import { TaskAgentReviewService } from './task-agent-review.service';
import { FacadesModule } from '../facades/facades.module';
import { PolicyModule } from '../policy/policy.module';
import { MergeApprovalModule } from '../agent-approvals/merge-approval.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AgentsModule } from '../agents/agents.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DatabaseModule } from '../database/database.module';
// APW-08 T10 — the evolve loop's rules resolver. It lives in `app-works/`
// with the rest of the App Works services and is PROVIDED here, which is what
// T10 specifies: the apps services sit in this module to avoid a module cycle
// with `TaskTransitionService`.
import { AppWorkRulesService } from '../app-works/app-work-rules.service';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';

/**
 * Tasks feature — Phases 11 + 12 + 13.
 *
 * Agent-side module that owns the Tasks family data surface +
 * the service layer (TasksService + TaskTransitionService +
 * TaskChatService).
 */
@Module({
    imports: [
        DatabaseModule,
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
            // CI feedback + autonomous fix loop (slice AC, EW-806) — the
            // durable attempt ledger that IS the retry budget. ALSO
            // registered in `_entities-inventory.ts` (no autoLoadEntities
            // in this repo) and in `_entity-names.ts`.
            TaskCiAutoResumeAttempt,
            // Reviewer agent stage (slice AD, EW-811) — the review ledger
            // that IS the review budget and the run → approver-row
            // binding. ALSO registered in `_entities-inventory.ts` (no
            // autoLoadEntities in this repo) and in `_entity-names.ts`.
            TaskAgentReview,
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
            // Repository registry (Feature G) — TaskWorkspaceService reads
            // the run agent's repo attachments for the advisory
            // `attachedRepos` provision-spec field. RepoConnection itself
            // needs no forFeature here: the relation loads through the
            // DataSource metadata (both entities are in ENTITIES).
            AgentRepoAttachment,
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
        // Merge approval (self-build slice AE, EW-805) — TaskMergeGate
        // raises the human approval for a green pull request and verifies
        // one before it asks for a merge.
        MergeApprovalModule,
    ],
    providers: [
        // APW-08 T10. It takes `AppSpecService` `@Optional()`, so this module
        // composes with or without APW-03 in the graph — without it, `resolve`
        // throws `AppSpecUnreadableError` naming the branch, which is the
        // documented refusal and not a boot failure.
        AppWorkRulesService,
        TaskRepository,
        TaskCiAutoResumeAttemptRepository,
        TaskAgentReviewRepository,
        AgentRepoAttachmentRepository,
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
        // Task board read model — true per-column totals and independent
        // column paging over TasksService.list (AW-02).
        TaskBoardService,
        TaskTemplatesService,
        TaskChatService,
        TaskRecurrenceDispatcherService,
        // Task-graph fan-out (slice AH) — starts TODO Tasks whose blockers
        // have cleared, through the same gated dispatch path everything
        // else uses. Off unless TASK_FANOUT_MAX_STARTS_PER_OWNER > 0.
        TaskGraphFanoutService,
        TaskNotificationService,
        TaskRunDenormService,
        TaskWorkspaceService,
        // Orchestration M9 - the write half of the rejection loop. Reads
        // TaskReviewRejectionRepository, which AgentsModule (imported
        // above) owns and exports alongside AgentRunRepository.
        TaskReviewRejectionService,
        // Merge approval (slice AE) — the approval twin of the rejection
        // recorder above: a HUMAN provider review approval, stamped with
        // the commit it was given for. Context for the person who makes
        // the real (platform-side) merge decision; never an authorization.
        TaskReviewApprovalService,
        // Merge approval (slice AE) — the post-CI re-evaluation of the
        // merge. Consumed by TaskPrStatusService right after every
        // successful provider read.
        TaskMergeGateService,
        // Git activity ingestion (audit item j) — read-only branch/PR →
        // Task resolver the GitHub receiver stamps onto push / commit /
        // merge events. Reads TaskRepository + WorkRepository, both
        // already provided above.
        TaskGitLinkService,
        // Kanban run cockpit (plan 04 M5/M6) — PR status cache + capped
        // diff reads. Uses the git facade (FacadesModule, imported above)
        // and TaskTransitionService for the merged-PR -> done landing.
        TaskPrStatusService,
        // CI feedback + autonomous fix loop (slice AC, EW-806) — the
        // decision layer behind the GitHub check receiver. Reads the
        // attempt ledger above, `AgentRunRepository` +
        // `TaskReviewRejectionRepository` (AgentsModule, imported above)
        // and `TaskGitLinkService`; resumes through the RUN_STEERING_PORT
        // the api-side @Global() AgentsModule binds. Every one of those
        // tokens is @Optional() at the injection site, so an install
        // without them files nothing and resumes nothing.
        TaskCiAutoResumeService,
        // Reviewer agent stage (self-build slice AD, EW-811) — plans the
        // review runs an entry into `in_review` buys, and records the
        // verdict those runs submit. Reads the review ledger above,
        // `TaskApproverRepository` (provided above), `AgentRunRepository`
        // + `AgentRepository` (AgentsModule, imported above) and the git
        // facade (FacadesModule). Every one of those is @Optional() at the
        // injection site, and the service refuses to review rather than
        // half-reviewing when one is missing.
        TaskAgentReviewService,
        // Wave 3 M2 — acceptance-check runner (quality gates). Needs only
        // AgentRunRepository (exported by AgentsModule above) to persist
        // per-run gate results.
        TaskGateRunnerService,
        // Judgment layer G2 — the LLM-vs-criteria judge that turns a green
        // gate into pass/retry/escalate. Consumes AiFacadeService only
        // (FacadesModule, imported above) and treats it as @Optional(), so
        // a deployment with no AI provider degrades to "no judge".
        TaskGateJudgeService,
        // Schedules — the per-template run-now claim `TasksService` holds
        // across the in-flight check, the instance insert and the dispatch.
        // Backed by `cache_entries` through DatabaseModule (imported above);
        // local, not exported, like CommunityPrModule's copy.
        DistributedTaskLockService,
    ],
    exports: [
        // Exported as well as provided: the dispatch brief, the Fleet
        // admission and the change guard all live outside this module and
        // must resolve the SAME instance, or they would read the spec
        // separately and come to disagree.
        AppWorkRulesService,
        TaskRepository,
        TaskCiAutoResumeAttemptRepository,
        TaskAgentReviewRepository,
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
        TaskBoardService,
        TaskTemplatesService,
        TaskChatService,
        TaskRecurrenceDispatcherService,
        TaskGraphFanoutService,
        TaskNotificationService,
        TaskRunDenormService,
        TaskWorkspaceService,
        TaskReviewRejectionService,
        TaskReviewApprovalService,
        TaskMergeGateService,
        TaskGitLinkService,
        TaskPrStatusService,
        TaskCiAutoResumeService,
        TaskAgentReviewService,
        TaskGateRunnerService,
        TaskGateJudgeService,
    ],
})
export class TasksDomainModule {}
