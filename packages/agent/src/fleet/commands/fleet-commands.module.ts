import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FleetCommand } from '../../entities/fleet-command.entity';
import { FleetCommandRun } from '../../entities/fleet-command-run.entity';
import { FleetModule } from '../fleet.module';
import { FleetCommandRepository } from './fleet-command.repository';
import { FleetCommandService } from './fleet-command.service';

/**
 * Commands on computers (FL-12) — the agent-side module owning
 * `fleet_commands` and `fleet_command_runs`: the repository and
 * `FleetCommandService` (the one writer). The node transport is the
 * `FLEET_COMMAND_NODE_PORT` the API binds (`@Optional()`: without it every
 * machine reads unreachable).
 *
 * Both entities are also registered in `database/_entities-inventory.ts` —
 * this repo has no `autoLoadEntities`.
 */
@Module({
    imports: [FleetModule, TypeOrmModule.forFeature([FleetCommand, FleetCommandRun])],
    providers: [FleetCommandRepository, FleetCommandService],
    exports: [FleetCommandRepository, FleetCommandService],
})
export class FleetCommandsModule {}
