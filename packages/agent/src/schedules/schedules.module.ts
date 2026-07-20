import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SchedulesService } from './schedules.service';

/**
 * Schedules ("Cadence") aggregation module (spec §9).
 *
 * Read-only. `DatabaseModule` exports `TypeOrmModule.forFeature(ENTITIES)`,
 * so importing it here makes the Task / Agent / WorkSchedule / Mission /
 * Work repositories injectable into `SchedulesService` without coupling
 * to any feature-specific custom repository.
 */
@Module({
    imports: [DatabaseModule],
    providers: [SchedulesService],
    exports: [SchedulesService],
})
export class SchedulesModule {}
