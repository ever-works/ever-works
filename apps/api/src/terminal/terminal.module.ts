import { Module } from '@nestjs/common';
import { AgentsModule } from '@ever-works/agent/agents';
import { DatabaseModule } from '@ever-works/agent/database';
import { TerminalRelayRegistry } from './terminal-relay.registry';
import { TerminalAttachService } from './terminal-attach.service';
import { TerminalAttachController } from './terminal-attach.controller';
import { TerminalInternalController } from './terminal-internal.controller';
import { TerminalWsService } from './terminal-ws.service';

/**
 * Streaming-terminal API module (M3): the relay registry (M2) wired to
 * a WebSocket gateway on the API's own HTTP server, an attach-token
 * endpoint behind the standard auth + run-ownership checks, and the
 * internal publish/worker-token endpoints behind the constant-time
 * internal-secret gate.
 *
 * Single-replica note: the in-process `FanoutBus` default applies —
 * cross-replica fan-out is a later milestone (Redis pub/sub behind the
 * same seam). Current deployments run one API replica.
 */
@Module({
    imports: [AgentsModule, DatabaseModule],
    controllers: [TerminalAttachController, TerminalInternalController],
    providers: [TerminalRelayRegistry, TerminalAttachService, TerminalWsService],
    exports: [TerminalRelayRegistry, TerminalAttachService],
})
export class TerminalModule {}
