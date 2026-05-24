import { Module } from '@nestjs/common';
import { MissionsModule as AgentMissionsModule } from '@ever-works/agent/missions';
import { BudgetsModule as AgentBudgetsModule } from '@ever-works/agent/budgets';
import { AuthModule } from '../auth/auth.module';
import { MissionsController } from './missions.controller';

/**
 * Phase 3 PR G — api-side MissionsModule (Missions/Ideas/Works
 * build). Phase 7 PR U pulls in the agent BudgetsModule so the
 * controller can wire `GET /me/missions/:id/budget` to
 * `BudgetService.summarizeForOwner`.
 */
@Module({
    imports: [AgentMissionsModule, AgentBudgetsModule, AuthModule],
    controllers: [MissionsController],
})
export class MissionsModule {}
