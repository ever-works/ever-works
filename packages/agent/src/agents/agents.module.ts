import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { AgentRunLog } from '../entities/agent-run-log.entity';
import { AgentBudget } from '../entities/agent-budget.entity';
import { AgentMembership } from '../entities/agent-membership.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { AgentMembershipRepository } from '../database/repositories/agent-membership.repository';
import { AgentsService } from './agents.service';
import { AgentFileService } from './agent-file.service';
import { AgentScheduleDispatcherService } from './agent-schedule-dispatcher.service';
import { AgentExportService } from './agent-export.service';
import { PromptAssemblerService } from './prompt-assembler.service';
import { AgentRunService } from './agent-run.service';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { SkillsModule } from '../skills/skills.module';

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
		TypeOrmModule.forFeature([Agent, AgentRun, AgentRunLog, AgentBudget, AgentMembership]),
		ActivityLogModule,
		// Phase 10 — AgentRunService resolves active skills via
		// SkillBindingRepository before assembling the prompt.
		SkillsModule,
	],
	providers: [
		AgentRepository,
		AgentRunRepository,
		AgentRunLogRepository,
		AgentBudgetRepository,
		AgentMembershipRepository,
		AgentsService,
		AgentFileService,
		AgentScheduleDispatcherService,
		AgentExportService,
		PromptAssemblerService,
		AgentRunService,
	],
	exports: [
		AgentRepository,
		AgentRunRepository,
		AgentRunLogRepository,
		AgentBudgetRepository,
		AgentMembershipRepository,
		AgentsService,
		AgentFileService,
		AgentScheduleDispatcherService,
		AgentExportService,
		PromptAssemblerService,
		AgentRunService,
	],
})
export class AgentsModule {}
