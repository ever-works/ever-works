import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { AgentAttachment } from '../entities/agent-attachment.entity';
import { Work } from '../entities/work.entity';
import { Mission } from '../entities/mission.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { UserUpload } from '../entities/user-upload.entity';
import { User } from '../entities/user.entity';
import { Environment } from '../entities/environment.entity';
import { Organization } from '../entities/organization.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { AgentRunLog } from '../entities/agent-run-log.entity';
import { AgentBudget } from '../entities/agent-budget.entity';
import { AgentMembership } from '../entities/agent-membership.entity';
import { AgentCollaborator } from '../entities/agent-collaborator.entity';
import { AgentEscalation } from '../entities/agent-escalation.entity';
import { TaskReviewRejection } from '../entities/task-review-rejection.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { AgentMembershipRepository } from '../database/repositories/agent-membership.repository';
import { AgentCollaboratorRepository } from '../database/repositories/agent-collaborator.repository';
import { AgentAttachmentRepository } from '../database/repositories/attachment.repositories';
import { AgentEscalationRepository } from '../database/repositories/agent-escalation.repository';
import { TaskReviewRejectionRepository } from '../database/repositories/task-review-rejection.repository';
import { AgentsService } from './agents.service';
import { AgentTemplatesService } from './agent-templates.service';
import { OnboardingRoleSeedingService } from './role-seeding.service';
import { AgentFileService } from './agent-file.service';
import { AgentScheduleDispatcherService } from './agent-schedule-dispatcher.service';
import { AgentRunSweeperService } from './agent-run-sweeper.service';
import { AgentExportService } from './agent-export.service';
import { PromptAssemblerService } from './prompt-assembler.service';
import { AgentRunService } from './agent-run.service';
import { RunDispatchGateService } from './run-dispatch-gate.service';
import { RunSteeringService } from './run-steering.service';
import { TerminalSessionLauncher } from './terminal-session-launcher.service';
import { AgentToolService } from './agent-tool.service';
import { AgentEscalationService } from './agent-escalation.service';
import { EscalationConfidenceService } from './escalation-confidence';
import { WorkflowGraphExecutorService } from './workflow-graph-executor.service';
import { WorkflowAiDecisionAdapter } from './workflow-ai-decision.adapter';
import { WORKFLOW_DECISION_PORT } from './workflow-graph.ports';
import { SubAgentDelegationService } from './sub-agent-delegation.service';
import { VisionContextService } from '../services/vision-context.service';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { SkillsModule } from '../skills/skills.module';
import { PolicyModule } from '../policy/policy.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FacadesModule } from '../facades/facades.module';

/**
 * Agents/Skills/Tasks — Phase 3 (PR #1017 specs). The agent-side
 * module that owns the Agent entity's data + service surface. The
 * api-side `apps/api/src/agents/AgentsModule` imports this one and
 * mounts the controller.
 *
 * Mirrors the structure of `@ever-works/agent/missions`. File-service
 * + run-service + dispatcher live in their own sub-modules added in
 * later phases (4 / 6 / 7).
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([
            Agent,
            AgentAttachment,
            AgentRun,
            AgentRunLog,
            AgentBudget,
            AgentMembership,
            // Agent Collaborators — per-agent sub-agent delegation allow-list.
            AgentCollaborator,
            // Judgment layer G3 - structured escalation records.
            AgentEscalation,
            // Orchestration M9 - durable reviewer rejections replayed by
            // RunSteeringService.resume. forFeature'd HERE (not in
            // TasksModule) because the reader lives in this module; the
            // entity is also registered in the DataSource ENTITIES array
            // (`database/_entities-inventory.ts`) - this repo has no
            // autoLoadEntities, so a forFeature'd-but-unregistered entity
            // throws EntityMetadataNotFoundError on first query.
            TaskReviewRejection,
            // Parent-existence validation for scoped Agents (IDOR fix): raw
            // repositories for the work/mission/idea a scoped Agent references.
            Work,
            Mission,
            WorkProposal,
            // Upload-ownership validation for addAttachment (user_uploads).
            UserUpload,
            // PR-6 — User + Organization back VisionContextService's
            // active-Org vision lookup for the run-prompt segment.
            User,
            Organization,
            // Environments — raw repo backing AgentsService's assignment
            // validation (same-user + published). Also registered in the
            // DataSource ENTITIES array (`database/_entities-inventory.ts`).
            Environment,
        ]),
        ActivityLogModule,
        // Wave 4 M6 - the sweeper notifies the owner when a run has been
        // queued past the bound. @Optional() injection, so this import is
        // what makes the attention surface actually fire in production.
        NotificationsModule,
        // Phase 10 — AgentRunService resolves active skills via
        // SkillBindingRepository before assembling the prompt.
        SkillsModule,
        // Audit items G4 + G12 + G14 — binds TOOL_GRANT_ENFORCER (the
        // tool-grant matrix consumed by AgentToolService and by
        // AgentRunService's skill activation) and CREDENTIAL_RESOLVER
        // (`{{cred.key}}` interpolation). Both are @Optional() at the
        // consumer, so WITHOUT this import the wiring silently never
        // fires — the same trap FacadesModule documents just below.
        // PolicyModule is a leaf (four scope entities + tool_grants), so
        // this import cannot cycle.
        PolicyModule,
        // PR #1084 follow-up: AgentRunService injects
        // AgentMemoryFacadeService (@Optional) so it can open + close a
        // memory session per run. Without this import the @Optional()
        // resolves to undefined in production and the wiring never
        // fires (Codex P1 on PR #1084).
        FacadesModule,
    ],
    providers: [
        AgentRepository,
        AgentRunRepository,
        AgentRunLogRepository,
        AgentBudgetRepository,
        AgentMembershipRepository,
        AgentCollaboratorRepository,
        AgentAttachmentRepository,
        AgentEscalationRepository,
        TaskReviewRejectionRepository,
        AgentsService,
        // Wave 10 — prebuilt agent-template activation (catalog data +
        // ordinary Agent rows; no new persistence concepts).
        AgentTemplatesService,
        // A55 — server-side, role-driven starter seeding for onboarding
        // (all 14 roles, agents AND skills; was a 3-role client filter).
        OnboardingRoleSeedingService,
        AgentFileService,
        AgentScheduleDispatcherService,
        AgentRunSweeperService,
        AgentExportService,
        PromptAssemblerService,
        // PR-6 — company-vision prompt context for AgentRunService's
        // appended COMPANY VISION segment (@Optional() injection).
        VisionContextService,
        AgentRunService,
        // Wave 4 M2 — concurrency choke point for run dispatch. The
        // AGENT_TASK_EXECUTE_DISPATCHER it drains through is @Optional()
        // and bound by the api-side @Global() TasksModule.
        RunDispatchGateService,
        // Wave 4 M5 — steer / interrupt / resume. Reuses the gate for resume
        // admission and the existing cancel path for stop.
        RunSteeringService,
        // Streaming terminal — the single dispatch choke point for the
        // `terminal-session` job. The TERMINAL_SESSION_DISPATCHER it
        // enqueues through is @Optional() and bound by the api-side
        // @Global() AgentsModule, exactly like RunDispatchGateService's.
        TerminalSessionLauncher,
        AgentToolService,
        // Judgment layer G3 - the one place a give-up becomes a record.
        AgentEscalationService,
        // Judgment layer G3 - scores the confidence column on every
        // escalation (AI judge through the AI facade, deterministic
        // table otherwise). FacadesModule is already imported above, so
        // the AiFacadeService it consumes resolves in production.
        EscalationConfidenceService,
        // Judgment layer G5 - workflow graph execution. The node runner
        // (WORKFLOW_NODE_RUNNER) stays @Optional() and is bound by the
        // host that owns node semantics; the decider is bound HERE to the
        // AI-facade adapter so every llm_decide call goes through the
        // facade/plugin seam (FacadesModule is already imported above).
        WorkflowAiDecisionAdapter,
        { provide: WORKFLOW_DECISION_PORT, useExisting: WorkflowAiDecisionAdapter },
        WorkflowGraphExecutorService,
        // Judgment layer G9 - scoped sub-agent delegation. The runner it
        // dispatches through (SUB_AGENT_DELEGATION_RUNNER) is @Optional()
        // and bound by the api-side @Global() module, exactly like
        // RunDispatchGateService's dispatcher.
        SubAgentDelegationService,
    ],
    exports: [
        AgentRepository,
        AgentRunRepository,
        AgentRunLogRepository,
        AgentBudgetRepository,
        AgentMembershipRepository,
        AgentCollaboratorRepository,
        AgentAttachmentRepository,
        AgentEscalationRepository,
        TaskReviewRejectionRepository,
        AgentsService,
        AgentTemplatesService,
        OnboardingRoleSeedingService,
        AgentFileService,
        AgentScheduleDispatcherService,
        AgentRunSweeperService,
        AgentExportService,
        PromptAssemblerService,
        AgentRunService,
        RunDispatchGateService,
        RunSteeringService,
        TerminalSessionLauncher,
        AgentToolService,
        AgentEscalationService,
        EscalationConfidenceService,
        WorkflowGraphExecutorService,
        WorkflowAiDecisionAdapter,
        WORKFLOW_DECISION_PORT,
        SubAgentDelegationService,
    ],
})
export class AgentsModule {}
