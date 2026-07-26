import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { AgentAttachment } from '../entities/agent-attachment.entity';
import { Work } from '../entities/work.entity';
import { Mission } from '../entities/mission.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { UserUpload } from '../entities/user-upload.entity';
import { User } from '../entities/user.entity';
import { Organization } from '../entities/organization.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { AgentRunLog } from '../entities/agent-run-log.entity';
import { AgentBudget } from '../entities/agent-budget.entity';
import { AgentMembership } from '../entities/agent-membership.entity';
import { AgentEscalation } from '../entities/agent-escalation.entity';
import { TaskReviewRejection } from '../entities/task-review-rejection.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { AgentMembershipRepository } from '../database/repositories/agent-membership.repository';
import { AgentAttachmentRepository } from '../database/repositories/attachment.repositories';
import { AgentEscalationRepository } from '../database/repositories/agent-escalation.repository';
import { TaskReviewRejectionRepository } from '../database/repositories/task-review-rejection.repository';
import { AgentsService } from './agents.service';
import { AgentTemplatesService } from './agent-templates.service';
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
import { VisionContextService } from '../services/vision-context.service';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { SkillsModule } from '../skills/skills.module';
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
        ]),
        ActivityLogModule,
        // Wave 4 M6 - the sweeper notifies the owner when a run has been
        // queued past the bound. @Optional() injection, so this import is
        // what makes the attention surface actually fire in production.
        NotificationsModule,
        // Phase 10 — AgentRunService resolves active skills via
        // SkillBindingRepository before assembling the prompt.
        SkillsModule,
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
        AgentAttachmentRepository,
        AgentEscalationRepository,
        TaskReviewRejectionRepository,
        AgentsService,
        // Wave 10 — prebuilt agent-template activation (catalog data +
        // ordinary Agent rows; no new persistence concepts).
        AgentTemplatesService,
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
    ],
    exports: [
        AgentRepository,
        AgentRunRepository,
        AgentRunLogRepository,
        AgentBudgetRepository,
        AgentMembershipRepository,
        AgentAttachmentRepository,
        AgentEscalationRepository,
        TaskReviewRejectionRepository,
        AgentsService,
        AgentTemplatesService,
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
    ],
})
export class AgentsModule {}
