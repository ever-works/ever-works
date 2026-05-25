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
	],
	providers: [
		AgentRepository,
		AgentRunRepository,
		AgentRunLogRepository,
		AgentBudgetRepository,
		AgentMembershipRepository,
		AgentsService,
	],
	exports: [
		AgentRepository,
		AgentRunRepository,
		AgentRunLogRepository,
		AgentBudgetRepository,
		AgentMembershipRepository,
		AgentsService,
	],
})
export class AgentsModule {}
