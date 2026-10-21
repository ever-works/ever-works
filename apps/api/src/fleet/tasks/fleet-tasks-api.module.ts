import { Module } from '@nestjs/common';
import { AgentsModule as AgentAgentsModule } from '@ever-works/agent/agents';
import { DatabaseModule } from '@ever-works/agent/database';
import { FleetCheckoutsModule, FleetGitModule, FleetModule, FleetSessionsModule } from '@ever-works/agent/fleet';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { FleetCheckoutsEnabledGuard } from '../checkouts/fleet-checkouts-enabled.guard';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetSessionsEnabledGuard } from '../sessions/fleet-sessions-enabled.guard';
import { FleetGitIdentityController } from './fleet-git-identity.controller';
import { FleetTaskHandoffController } from './fleet-task-handoff.controller';
import { FleetTaskHandoffService } from './fleet-task-handoff.service';

/**
 * Tasks on computers (FL-15) — the API half of **Fix with an agent on this
 * computer**: `GET /api/fleet/tasks/:taskId/handoff-options` (dark unless
 * `FLEET_SESSIONS_ENABLED` and `FLEET_CHECKOUTS_ENABLED`), and (P2) a
 * computer's git identity, `GET/POST /api/fleet/nodes/:id/git/identity`
 * (dark unless `FLEET_CHECKOUTS_ENABLED`).
 *
 * The options service reads `TasksService.listRunCandidates` — the resolver
 * Run with agent uses (spec FR-4) — so it lives here, over
 * `TasksDomainModule`, rather than in an agent-side fleet module (lane-log
 * decision 2). The node link port (`FLEET_SESSION_NODE_PORT`) comes from the
 * global `FleetSessionsApiModule`. Nothing imports this module back.
 */
@Module({
    imports: [
        DatabaseModule,
        TasksDomainModule,
        AgentAgentsModule,
        FleetModule,
        FleetSessionsModule,
        FleetCheckoutsModule,
        // P2: a computer's git identity (over FL-09's global machine port).
        FleetGitModule,
    ],
    controllers: [FleetTaskHandoffController, FleetGitIdentityController],
    providers: [
        FleetTaskHandoffService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetSessionsEnabledGuard,
        FleetCheckoutsEnabledGuard,
    ],
    exports: [FleetTaskHandoffService],
})
export class FleetTasksApiModule {}
