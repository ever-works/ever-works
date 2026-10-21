import { Global, Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    AGENT_SESSION_DISPATCHER,
    FLEET_SESSION_NODE_PORT,
    FLEET_SESSION_RECORDER,
    FleetSessionsModule,
} from '@ever-works/agent/fleet';
import { TerminalTranscriptModule } from '@ever-works/agent/agents';
import { FleetSessionRecorderService } from './fleet-session-recorder.service';
import { FleetSessionRecordingService } from './fleet-session-recording.service';
import { FleetApiModule } from '../fleet.module';
import { agentSessionDispatcherProvider } from './agent-session.dispatcher.provider';
import { AgentSessionJobListener } from './agent-session-job.listener';
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
    // P2: FleetApiModule for the node job runtime's dispatcher factory (the
    // `agent-session` job); it does not import this module, so no cycle.
    // P3: TerminalTranscriptModule for the recordings (persist, page, stats).
    imports: [FleetSessionsModule, DatabaseModule, FleetApiModule, TerminalTranscriptModule],
    controllers: [FleetSessionsController],
    providers: [
        FleetSessionLinkAdapter,
        { provide: FLEET_SESSION_NODE_PORT, useExisting: FleetSessionLinkAdapter },
        FleetSessionLinkListener,
        FleetSessionSweepCronService,
        // P1b: who is attached (observes FL-02's viewer gateway) and the attach token.
        FleetSessionPresenceService,
        FleetSessionAttachService,
        // P2: Agent sessions — the job dispatch port and its lifecycle listener.
        agentSessionDispatcherProvider,
        AgentSessionJobListener,
        // P3: recording — the recorder (bound to the session service's port)
        // and the manifest / page reader.
        FleetSessionRecorderService,
        { provide: FLEET_SESSION_RECORDER, useExisting: FleetSessionRecorderService },
        FleetSessionRecordingService,
        DistributedTaskLockService,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetSessionsEnabledGuard,
    ],
    exports: [FLEET_SESSION_NODE_PORT, AGENT_SESSION_DISPATCHER, FLEET_SESSION_RECORDER, FleetSessionsModule],
})
export class FleetSessionsApiModule {}
