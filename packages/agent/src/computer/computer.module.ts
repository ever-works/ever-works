import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ComputerSession } from '../entities/computer-session.entity';
import { NodeAgentProfile } from '../entities/node-agent-profile.entity';
import { FleetModule } from '../fleet/fleet.module';
import { ComputerSessionRepository } from './computer-session.repository';
import { ComputerSessionService } from './computer-session.service';
import { NodeAgentProfileRepository } from './node-agent-profile.repository';
import { NodeAgentProfileService } from './node-agent-profile.service';

/**
 * Agent computers — the domain module behind watching the machine an Agent
 * works on: the live-view session lifecycle and each Agent's own profile on
 * each Node.
 *
 * It sits ON the fleet rather than inside it. The fleet owns the machines,
 * the lease protocol, the stop flag and the audit ledger; this module reads
 * them (through `FleetModule`'s exports) and adds nothing to that module's
 * graph, so the fleet stays independent of whether anyone ever watches a
 * machine.
 *
 * `COMPUTER_SESSION_DISPATCHER` is NOT provided here: the API binds it to
 * the node job-runtime plugin. Unbound, opening a session answers
 * `dispatcher-unavailable` rather than failing to boot.
 *
 * Both entities are also registered in `database/_entities-inventory.ts`.
 */
@Module({
    imports: [TypeOrmModule.forFeature([ComputerSession, NodeAgentProfile]), FleetModule],
    providers: [
        ComputerSessionRepository,
        NodeAgentProfileRepository,
        ComputerSessionService,
        NodeAgentProfileService,
    ],
    exports: [
        ComputerSessionRepository,
        NodeAgentProfileRepository,
        ComputerSessionService,
        NodeAgentProfileService,
    ],
})
export class ComputerModule {}
