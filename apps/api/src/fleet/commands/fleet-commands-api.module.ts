import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { FLEET_COMMAND_NODE_PORT, FleetCommandsModule } from '@ever-works/agent/fleet';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetCommandLinkAdapter } from './fleet-command-link.adapter';
import { FleetCommandsController } from './fleet-commands.controller';
import { FleetCommandsEnabledGuard } from './fleet-commands-enabled.guard';

/**
 * Commands on computers (FL-12) — the API half:
 *
 *   - `FleetCommandsController` — `/api/fleet/commands[/:id[/runs|/cancel]]`
 *     (dark unless `FLEET_COMMANDS_ENABLED`);
 *   - `FleetCommandLinkAdapter` — binds the agent package's
 *     `FLEET_COMMAND_NODE_PORT` to the node link (FL-02): one `command`
 *     channel per run.
 *
 * `@Global()` for the reason `FleetSessionsApiModule` documents: the
 * agent-side `FleetCommandsModule` consumes `FLEET_COMMAND_NODE_PORT`
 * `@Optional()` and must not import the API, so the binding is reached
 * through the global scope (and P2's Agent tools reach `FleetCommandService`
 * the same way). The adapter needs `FleetLinkService`, which the global
 * `FleetLinkApiModule` exports; nothing it injects needs the command service
 * back, so there is no provider cycle.
 */
@Global()
@Module({
    imports: [FleetCommandsModule, DatabaseModule],
    controllers: [FleetCommandsController],
    providers: [
        FleetCommandLinkAdapter,
        { provide: FLEET_COMMAND_NODE_PORT, useExisting: FleetCommandLinkAdapter },
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetCommandsEnabledGuard,
    ],
    exports: [FLEET_COMMAND_NODE_PORT, FleetCommandsModule],
})
export class FleetCommandsApiModule {}
