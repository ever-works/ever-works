import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FleetCommand } from '../../entities/fleet-command.entity';
import { FleetCommandRun } from '../../entities/fleet-command-run.entity';
import { FleetModule } from '../fleet.module';
import { FleetScheduleNeedsALookProducer } from './fleet-schedule-needs-a-look.producer';
import { FleetScheduleRepository } from './fleet-schedule.repository';
import { FleetScheduleService } from './fleet-schedule.service';

/**
 * Schedules on computers (FL-13) — the agent-side module for Command
 * schedules: the repository (over FL-12's two tables), `FleetScheduleService`
 * (the one writer of schedule rows and of the runs the machines report) and
 * the `schedule-failed` Needs-a-look producer, which registers itself into
 * FL-01's registry when the module starts.
 *
 * The node transport is the `FLEET_SCHEDULE_NODE_PORT` the API binds
 * (`@Optional()`: without it no machine is reached and every schedule reads
 * "will sync"). Both entities are already in `database/_entities-inventory.ts`
 * (FL-12 registered them).
 */
@Module({
    imports: [FleetModule, TypeOrmModule.forFeature([FleetCommand, FleetCommandRun])],
    providers: [FleetScheduleRepository, FleetScheduleService, FleetScheduleNeedsALookProducer],
    exports: [FleetScheduleRepository, FleetScheduleService],
})
export class FleetSchedulesModule {}
