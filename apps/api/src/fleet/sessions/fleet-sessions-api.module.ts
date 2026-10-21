import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import { FLEET_SESSION_NODE_PORT, FleetSessionsModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetSessionAttachService } from './fleet-session-attach.service';
import { FleetSessionLinkAdapter } from './fleet-session-link.adapter';
import { FleetSessionPresenceService } from './fleet-session-presence.service';
import { FleetSessionLinkListener } from './fleet-session-link.listener';
import { FleetSessionSweepCronService } from './fleet-session-sweep-cron.service';
import { FleetSessionsController } from './fleet-sessions.controller';
import { FleetSessionsEnabledGuard } from './fleet-sessions-enabled.guard';

/**
 * Sessions on computers (FL-04) — the API half:
 *
 *   - `FleetSessionsController` — `/api/fleet/nodes/:id/sessions`,
 *     `/api/fleet/sessions[/:id[/end|/restart]]` (dark unless
 *     `FLEET_SESSIONS_ENABLED`);
 *   - `FleetSessionLinkAdapter` — binds the agent package's
 *     `FLEET_SESSION_NODE_PORT` to the node link (FL-02);
 *   - `FleetSessionLinkListener` — `session.event` / `session.list` from the
 *     machines into `FleetSessionService`;
 *   - `FleetSessionSweepCronService` — the sweeper when Trigger.dev is not
 *     the runtime;
 *   - `FleetSessionPresenceService` + `FleetSessionAttachService` (P1b) — the
 *     browser's attach token through FL-02's minter, who is attached, the
 *     five-viewer cap and the driver-span audit.
 *
 * `@Global()` for the reason `FleetLinkApiModule` documents: the agent-side
 * `FleetSessionsModule` consumes `FLEET_SESSION_NODE_PORT` `@Optional()` and
 * must not import the API, so the binding is reached through the global
 * scope; and the trigger-internal controller reaches `FleetSessionSweepService`
 * (re-exported here with `FleetSessionsModule`) without importing this module.
 * The adapter needs `FleetLinkService` and `FleetLinkRegistry`, which the
 * global `FleetLinkApiModule` exports; nothing it injects needs the session
 * service back, so there is no provider cycle.
 */
@Global()
@Module({
    imports: [FleetSessionsModule, DatabaseModule],
    controllers: [FleetSessionsController],
    providers: [
        FleetSessionLinkAdapter,
        { provide: FLEET_SESSION_NODE_PORT, useExisting: FleetSessionLinkAdapter },
        FleetSessionLinkListener,
        FleetSessionSweepCronService,
        // P1b: who is attached (observes FL-02's viewer gateway) and the attach token.
        FleetSessionPresenceService,
        FleetSessionAttachService,
        DistributedTaskLockService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetSessionsEnabledGuard,
    ],
    exports: [FLEET_SESSION_NODE_PORT, FleetSessionsModule],
})
export class FleetSessionsApiModule {}
