import { Global, Module } from '@nestjs/common';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { AgentsModule } from '@ever-works/agent/agents';
import {
    COMPUTER_PENDING_SESSIONS,
    COMPUTER_SESSION_DISPATCHER,
    ComputerModule as AgentComputerModule,
    ComputerSessionService,
} from '@ever-works/agent/computer';
import { FleetApiModule } from '../fleet/fleet.module';
import { FleetEnabledGuard } from '../fleet/guards/fleet-enabled.guard';
import { FleetNodeAuthGuard } from '../fleet/guards/fleet-node-auth.guard';
import { TerminalModule } from '../terminal/terminal.module';
import { ComputerAttachService } from './computer-attach.service';
import { ComputerControlListener } from './computer-control.listener';
import { ComputerController } from './computer.controller';
import { ComputerInternalController } from './computer-internal.controller';
import { COMPUTER_RELAY_REQUIRES_CONTROL, ComputerRelayRegistry } from './computer-relay.registry';
import { computerSessionDispatcherProvider } from './computer-session.dispatcher.provider';
import { ComputerSessionListener } from './computer-session.listener';
import { ComputerWsService } from './computer-ws.service';

/**
 * Agent computers — watch the machine an Agent works on, from the Agent's
 * page. The API half of the live view: the owner-facing session routes, the
 * machine-facing publish routes, an in-memory relay and a WebSocket gateway
 * on this process's HTTP server.
 *
 * Built from what already ships rather than beside it:
 *   - the domain (sessions, per-Agent profiles, the pure rules) is the
 *     agent-side `ComputerModule`, which sits ON the fleet;
 *   - attach tokens are the streaming terminal's signer (`TerminalModule`
 *     exports it), with a channel claim so the two can never cross;
 *   - machine authentication is the fleet's own `FleetNodeAuthGuard`, and
 *     the `computer-session` job is enqueued through the fleet's node job
 *     runtime factory (`FleetApiModule` exports it);
 *   - taking control is the agent-side control arbiter (a compare-and-set on
 *     the machine's row) behind the same routes, relay and gateway — no
 *     second session store and no second relay;
 *   - the whole surface goes dark with `FLEET_ENABLED=false`.
 *
 * `@Global()` for one reason, the same one the api-side `AgentsModule`
 * documents: two tokens bound HERE are consumed through `@Optional()`
 * injections in modules that must not import this one —
 * `COMPUTER_SESSION_DISPATCHER` by the agent-side session service, and
 * `COMPUTER_PENDING_SESSIONS` by the fleet heartbeat. Only exported
 * providers are published, so both are exported.
 */
@Global()
@Module({
    imports: [
        AgentComputerModule,
        AgentsModule,
        TerminalModule,
        FleetApiModule,
        // The control listener's Activity Log rows.
        ActivityLogModule,
    ],
    controllers: [ComputerController, ComputerInternalController],
    providers: [
        computerSessionDispatcherProvider,
        { provide: COMPUTER_PENDING_SESSIONS, useExisting: ComputerSessionService },
        ComputerAttachService,
        ComputerRelayRegistry,
        ComputerWsService,
        ComputerSessionListener,
        // Taking control: input is forwarded only from the view holding control
        // (the arbiter lives in the agent-side module), and the relay follows
        // every change of control whichever path made it.
        { provide: COMPUTER_RELAY_REQUIRES_CONTROL, useValue: true },
        ComputerControlListener,
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetNodeAuthGuard,
    ],
    exports: [COMPUTER_SESSION_DISPATCHER, COMPUTER_PENDING_SESSIONS, ComputerRelayRegistry],
})
export class ComputerApiModule {}
