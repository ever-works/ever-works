import { Module } from '@nestjs/common';
import { EnvironmentsModule as AgentEnvironmentsModule } from '@ever-works/agent/environments';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { AuthModule } from '../auth/auth.module';
import { EnvironmentsController } from './environments.controller';

/**
 * Environments (Settings → Environments) — api-side module. Mounts the
 * controller; defers to the agent-side `EnvironmentsModule` for the
 * service + repository + entities (same posture as api-side
 * AgentsModule → agent-side AgentsModule).
 */
@Module({
    imports: [AgentEnvironmentsModule, ActivityLogModule, AuthModule],
    controllers: [EnvironmentsController],
})
export class EnvironmentsApiModule {}
