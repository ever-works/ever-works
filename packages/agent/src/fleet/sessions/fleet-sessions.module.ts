import { Injectable, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FleetSession } from '../../entities/fleet-session.entity';
import { FleetModule } from '../fleet.module';
import { FleetSessionRepository } from './fleet-session.repository';
import { FleetSessionService } from './fleet-session.service';

/**
 * Sessions on computers (FL-04) — the sweeper's one-member facade.
 *
 * The `fleet-session-sweeper` cron reaches the API over the internal worker
 * RPC, whose allow-list is derived from a service's prototype. Exposing
 * `FleetSessionService` itself would publish start / end / rename to the
 * worker; this facade publishes exactly `sweepStale()`.
 */
@Injectable()
export class FleetSessionSweepService {
    constructor(private readonly sessions: FleetSessionService) {}

    sweepStale(): Promise<{ ended: number }> {
        return this.sessions.sweepStale();
    }
}

/**
 * Sessions on computers (FL-04) — the agent-side module owning
 * `fleet_sessions`: the repository, `FleetSessionService` (the one writer)
 * and the sweeper facade. The node transport is the `FLEET_SESSION_NODE_PORT`
 * the API binds (`@Optional()`: without it every machine reads unreachable).
 *
 * `FleetSession` is also registered in `database/_entities-inventory.ts` —
 * this repo has no `autoLoadEntities`.
 */
@Module({
    imports: [FleetModule, TypeOrmModule.forFeature([FleetSession])],
    providers: [FleetSessionRepository, FleetSessionService, FleetSessionSweepService],
    exports: [FleetSessionRepository, FleetSessionService, FleetSessionSweepService],
})
export class FleetSessionsModule {}
