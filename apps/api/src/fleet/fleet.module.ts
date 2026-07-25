import { Module } from '@nestjs/common';
import { FleetModule as AgentFleetModule } from '@ever-works/agent/fleet';
import { FleetController } from './fleet.controller';

/**
 * Fleet (Wave 12, slice 1) — thin API module exposing `/api/fleet`
 * (owner-scoped node CRUD-lite + the public token-authenticated
 * enroll/heartbeat endpoints) over the agent-side `FleetModule`
 * (entity, repository, enrollment/heartbeat crypto and the offline
 * sweep all live there).
 */
@Module({
    imports: [AgentFleetModule],
    controllers: [FleetController],
    exports: [AgentFleetModule],
})
export class FleetApiModule {}
