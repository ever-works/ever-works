import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EverInstanceService } from './ever-instance.service';
import { InstanceStatsRepository } from './instance-stats.repository';

/**
 * The installation identity primitive and the aggregate queries of the
 * anonymous usage statistics module.
 *
 * Imported ONLY by the API's statistics module, which itself is imported only
 * when `EVER_STATS_ENABLED` is not `false`: with statistics switched off this
 * module is not in the graph, so no identity row is created and no key is
 * generated. It has no route, no timer and no network code.
 *
 * `DatabaseModule` provides the TypeORM feature registration of every entity
 * (the three statistics entities included) and the data source the aggregate
 * queries run on.
 */
@Module({
    imports: [DatabaseModule],
    providers: [EverInstanceService, InstanceStatsRepository],
    exports: [EverInstanceService, InstanceStatsRepository],
})
export class EverInstanceModule {}
