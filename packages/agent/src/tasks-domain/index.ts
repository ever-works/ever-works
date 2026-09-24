// Public surface of the agent-side Tasks domain module
// (Agents/Skills/Tasks PR #1017 — Phase 11). Distinct from
// `@ever-works/agent/tasks` which is the Trigger.dev jobs subpath
// — this module owns the per-Task DB entities + repositories.
export * from './tasks.module';
export * from './tasks.service';
// Task board read model (AW-02) — per-column true totals + column paging.
export * from './task-board.service';
export * from './task-gates';
export * from './task-gate-runner.service';
export * from './task-gate-judge.service';
export * from './check-env';
export * from './task-transition.service';
export * from './task-chat.service';
export * from './task-dispatcher';
export * from './run-steering-port';
export * from './task-isolation';
export * from './task-run-denorm.service';
export * from './task-workspace.service';
// APW-08 T17 — the App Work change gate's port, so the agent git tools can ask
// the same gate before they open a pull request.
export * from './app-work-change-gate.port';
// The repository a Task acts on — the per-kind rule every Task path uses.
export * from './task-repository';
// PR insights (kanban run cockpit M5/M6) — PR status cache + capped diff.
export * from './task-pr-status.service';
export * from './agent-task-tools';
export * from './recurrence';
export * from './task-recurrence-dispatcher.service';
// Task-graph fan-out (slice AH) — the bounded TODO-with-no-open-blockers driver.
export * from './task-graph-fanout.service';
// THE extraRepos validator, shared by Tasks and Task Template steps.
export * from './task-extra-repos';
// Repository-declared commands (EW-807) — the strict reader for
// `.works/works.yml` `spec.tasks`, and the owner allow-list that admits it.
export * from './repo-declared-commands';
export * from './task-notification.service';
export * from './task-templates.service';
export { Task, TaskPriority, TaskStatus, type TaskActorType } from '../entities/task.entity';
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
export { TaskAttachment, type TaskAttachmentRole } from '../entities/task-attachment.entity';
export { TaskTemplate } from '../entities/task-template.entity';
export { TaskTemplateStep } from '../entities/task-template-step.entity';
export { TaskWatcher } from '../entities/task-watcher.entity';
export { TaskKbMention } from '../entities/task-kb-mention.entity';
export { UserTaskCounter } from '../entities/user-task-counter.entity';
export { TaskRepository, type ListTasksFilter } from '../database/repositories/task.repository';
export { TaskTemplateRepository } from '../database/repositories/task-template.repository';
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
export * from './task-review-rejection.service';
// Merge approval (self-build slice AE, EW-805).
export * from './task-review-approval.service';
export * from './task-merge-gate.service';
// CI feedback + autonomous fix loop (slice AC, EW-806) — the pure policy
// helpers and the decision layer the GitHub check receiver calls.
export * from './task-ci-auto-resume';
export * from './task-ci-auto-resume.service';
export {
    TaskCiAutoResumeAttempt,
    TASK_AUTO_RESUME_TRIGGERS,
    type TaskAutoResumeTrigger,
} from '../entities/task-ci-auto-resume-attempt.entity';
export {
    TaskCiAutoResumeAttemptRepository,
    type ClaimAutoResumeAttemptInput,
} from '../database/repositories/task-ci-auto-resume-attempt.repository';
// Reviewer agent stage (slice AD, EW-811) — the pure rules, the service
// that plans reviews + records verdicts, and the review ledger.
export * from './task-agent-review';
export * from './task-agent-review.service';
export * from './task-dispatch-agents';
export {
    TaskAgentReview,
    TASK_AGENT_REVIEW_STATES,
    TASK_AGENT_REVIEW_CLAIM_KEY_MAX_CHARS,
    type TaskAgentReviewState,
} from '../entities/task-agent-review.entity';
export {
    TaskAgentReviewRepository,
    type ClaimAgentReviewInput,
    type ClaimAgentReviewResult,
    type RecordAgentVerdictInput,
    type RecordAgentVerdictOutcome,
} from '../database/repositories/task-agent-review.repository';
// Release promotion lane (self-build slice AI, EW-808) — develop -> stage
// -> main. Opens a promotion pull request and reports the gate; merging it
// stays on the slice-AE human-approval path.
export * from './release-promotion.service';
export * from './release-verification.service';
export * from './release-promotion.module';
export { ReleasePromotion } from '../entities/release-promotion.entity';
export {
    ReleasePromotionRepository,
    type ClaimPromotionLaneInput,
    type PromotionLaneClaim,
} from '../database/repositories/release-promotion.repository';
// Git activity ingestion (audit item j) — branch/PR → Task resolver.
export * from './task-git-link.service';
export {
    TaskReviewRejectionRepository,
    type RecordTaskReviewRejectionInput,
} from '../database/repositories/task-review-rejection.repository';
// Trusted review bots (R16) — the classification a bridge attaches to a
// reviewer-bot finding, exported so api-side writers speak the same union.
export {
    TASK_REVIEW_REJECTION_SEVERITIES,
    type TaskReviewRejectionReviewerKind,
    type TaskReviewRejectionSeverity,
} from '../entities/task-review-rejection.entity';
