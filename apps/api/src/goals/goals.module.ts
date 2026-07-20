import { Module } from '@nestjs/common';
import { GoalsModule as AgentGoalsModule } from '@ever-works/agent/goals';
import { AuthModule } from '../auth/auth.module';
import { GoalsController } from './goals.controller';

/**
 * Goals & Metrics — PR-8. Api-side module exposing the
 * `/api/me/goals` surface. The domain logic (CRUD + lifecycle +
 * evaluation) lives in the agent-side {@link AgentGoalsModule};
 * Mission link/unlink endpoints live on the MissionsController
 * (which imports the same agent module for `GoalsService`).
 */
@Module({
    imports: [AgentGoalsModule, AuthModule],
    controllers: [GoalsController],
})
export class GoalsModule {}
