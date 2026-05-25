import { Module } from '@nestjs/common';
import { AgentsModule as AgentAgentsModule } from '@ever-works/agent/agents';
import { AuthModule } from '../auth/auth.module';
import { AgentsController } from './agents.controller';

/**
 * Agents/Skills/Tasks PR #1017 — api-side AgentsModule (Phase 3).
 * Mounts the controller; defers to the agent-side module for the
 * service + repositories + entities.
 */
@Module({
	imports: [AgentAgentsModule, AuthModule],
	controllers: [AgentsController],
})
export class AgentsModule {}
