import { Module } from '@nestjs/common';
import { MissionsModule as AgentMissionsModule } from '@ever-works/agent/missions';
import { AuthModule } from '../auth/auth.module';
import { MissionsController } from './missions.controller';

/**
 * Phase 3 PR G — api-side MissionsModule (Missions/Ideas/Works
 * build).
 *
 * Thin wrapper that imports the agent-side `MissionsModule` (which
 * provides + exports `MissionsService`) plus `AuthModule` so the
 * `@CurrentUser()` decorator can resolve the authenticated user.
 *
 * Mirrors the work-agent module wrapper pattern. PR H adds Mission
 * CRUD/lifecycle endpoints; PR HH adds Clone; PR J (tick worker)
 * wires the Trigger.dev cron that calls into MissionsService.
 */
@Module({
    imports: [AgentMissionsModule, AuthModule],
    controllers: [MissionsController],
})
export class MissionsModule {}
