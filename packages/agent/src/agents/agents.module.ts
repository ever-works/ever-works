import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { AgentAttachment } from '../entities/agent-attachment.entity';
import { Work } from '../entities/work.entity';
import { Mission } from '../entities/mission.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { UserUpload } from '../entities/user-upload.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { AgentRunLog } from '../entities/agent-run-log.entity';
import { AgentBudget } from '../entities/agent-budget.entity';
import { AgentMembership } from '../entities/agent-membership.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { AgentMembershipRepository } from '../database/repositories/agent-membership.repository';
import { AgentAttachmentRepository } from '../database/repositories/attachment.repositories';
import { AgentsService } from './agents.service';
import { AgentFileService } from './agent-file.service';
import { AgentScheduleDispatcherService } from './agent-schedule-dispatcher.service';
import { AgentExportService } from './agent-export.service';
import { PromptAssemblerService } from './prompt-assembler.service';
import { AgentRunService } from './agent-run.service';
import { AgentToolService } from './agent-tool.service';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { SkillsModule } from '../skills/skills.module';
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
            // Parent-existence validation for scoped Agents (IDOR fix): raw
            // repositories for the work/mission/idea a scoped Agent references.
            Work,
            Mission,
            WorkProposal,
            // Upload-ownership validation for addAttachment (user_uploads).
            UserUpload,
        ]),
        ActivityLogModule,
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
        AgentsService,
        AgentFileService,
        AgentScheduleDispatcherService,
        AgentExportService,
        PromptAssemblerService,
        AgentRunService,
        AgentToolService,
    ],
    exports: [
        AgentRepository,
        AgentRunRepository,
        AgentRunLogRepository,
        AgentBudgetRepository,
        AgentMembershipRepository,
        AgentAttachmentRepository,
        AgentsService,
        AgentFileService,
        AgentScheduleDispatcherService,
        AgentExportService,
        PromptAssemblerService,
        AgentRunService,
        AgentToolService,
    ],
})
export class AgentsModule {}
