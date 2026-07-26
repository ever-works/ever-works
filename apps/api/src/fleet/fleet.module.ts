import { Module } from '@nestjs/common';
import { FleetModule as AgentFleetModule } from '@ever-works/agent/fleet';
import { FleetController } from './fleet.controller';
import { FleetJobsController } from './fleet-jobs.controller';

/**
 * Fleet (Wave 12, slice 1 + Desktop PRD M4) — thin API module exposing
 * `/api/fleet` over the agent-side `FleetModule` (entities,
 * repositories, enrollment/heartbeat crypto, the job lease protocol and
 * the offline sweep all live there).
 *
 * Two controllers, two trust boundaries — kept apart deliberately:
 *   - `FleetController` — owner-scoped registry management
 *     (session/API-key auth) plus the public token-authenticated
 *     enroll/heartbeat pair.
 *   - `FleetJobsController` — the node work channel (lease / job
 *     heartbeat / complete), node-secret authenticated, public,
 *     fail-closed to one undifferentiated 401.
 */
@Module({
    imports: [AgentFleetModule],
    controllers: [FleetController, FleetJobsController],
    exports: [AgentFleetModule],
})
export class FleetApiModule {}
