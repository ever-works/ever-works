import { Injectable, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { FleetCheckout } from '../../entities/fleet-checkout.entity';
import { FleetSession } from '../../entities/fleet-session.entity';
import { Task } from '../../entities/task.entity';
import { AgentRepository } from '../../database/repositories/agent.repository';
import { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import { FleetCheckoutRepository } from '../checkouts/fleet-checkout.repository';
import { FleetModule } from '../fleet.module';
import { FleetSessionRepository } from './fleet-session.repository';
import { FleetSessionService } from './fleet-session.service';
import { FleetSessionStateService } from './fleet-session-state.service';
import { FleetSessionAttentionDelivery } from './fleet-session-attention.delivery';
import { FLEET_SESSION_ATTENTION_SINK } from './fleet-session-attention.port';
import { SessionNeedsYouProducer } from './session-needs-you.producer';
import { NotificationsModule } from '../../notifications/notifications.module';
import { FleetSessionTaskService } from './fleet-session-task.service';

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
    // P2: the Agent and its Run, for Agent sessions (repositories provided here
    // as FleetModule provides `ApiKeyRepository` — stateless, so a second
    // instance is harmless and this module needs no DatabaseModule).
    // FL-05: the session notifications (`NotificationService`).
    // FL-15 P1: the Task a session works on and the checkout it starts in —
    // their repositories provided here the same stateless way (FleetCheckoutsModule
    // imports this module, so this one cannot import it back).
    imports: [
        FleetModule,
        NotificationsModule,
        TypeOrmModule.forFeature([FleetSession, Agent, AgentRun, Task, FleetCheckout]),
    ],
    providers: [
        FleetSessionRepository,
        FleetSessionService,
        FleetSessionSweepService,
        // FL-05: the writer of what a machine reports about a session's status,
        // and where an attention edge is delivered (Inbox, notifications).
        FleetSessionStateService,
        FleetSessionAttentionDelivery,
        { provide: FLEET_SESSION_ATTENTION_SINK, useExisting: FleetSessionAttentionDelivery },
        // FL-05: the hub's "needs a look" rows for sessions (registers itself at init).
        SessionNeedsYouProducer,
        AgentRepository,
        AgentRunRepository,
        FleetSessionTaskService,
        FleetCheckoutRepository,
    ],
    exports: [
        FleetSessionRepository,
        FleetSessionService,
        FleetSessionSweepService,
        FleetSessionStateService,
        FleetSessionAttentionDelivery,
        FleetSessionTaskService,
    ],
})
export class FleetSessionsModule {}
