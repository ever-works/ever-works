import { type MiddlewareConsumer, Module, type NestModule, type Type } from '@nestjs/common';
import { randomInt } from 'crypto';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { DatabaseModule } from '@ever-works/agent/database';
import {
    EverInstanceModule,
    isEverStatsModuleEnabled,
    readEverStatsConfig,
} from '@ever-works/agent/ever-instance';
import { FacadesModule } from '@ever-works/agent/facades';
import { IsPlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { SessionOnlyGuard } from '../auth/guards/session-only.guard';
import { InstanceStatsBuilderService } from './instance-stats-builder.service';
import { InstanceStatsController } from './instance-stats.controller';
import { InstanceStatsLeaseService } from './instance-stats-lease.service';
import { InstanceStatsOffMiddleware } from './instance-stats-off.middleware';
import { InstanceStatsSchedulerService } from './instance-stats-scheduler.service';
import { InstanceStatsSenderService } from './instance-stats-sender.service';
import { InstanceStatsService } from './instance-stats.service';
import { InstanceStatsSigner } from './instance-stats-signer';
import {
    INSTANCE_STATS_CLOCK,
    INSTANCE_STATS_CONFIG,
    INSTANCE_STATS_RANDOM,
} from './instance-stats.tokens';

/**
 * Anonymous usage statistics: one signed, schema-validated
 * `ever.stats.v1` report a day, with instance-wide counts, feature switches
 * and monthly aggregates — nothing that names a person or an organization.
 *
 * On by default for an installation; off with `EVER_STATS_ENABLED=false`
 * (then this module is not imported at all — see {@link instanceStatsModuleImports})
 * or with the operator switch in Settings (the module stays loaded and makes
 * no request). Delivery goes through the `stats-sink` capability.
 *
 * Should the module be in the graph although `EVER_STATS_ENABLED` switches it
 * off (the import decision runs when `ApiModule` is imported, so it depends on
 * the environment being loaded first), it still does nothing: the routes
 * answer 404 ({@link InstanceStatsOffMiddleware}), the scheduler starts no
 * timer and the sender refuses, all from the configuration read when the
 * module is created.
 */
@Module({
    imports: [DatabaseModule, EverInstanceModule, FacadesModule, ActivityLogModule],
    controllers: [InstanceStatsController],
    providers: [
        { provide: INSTANCE_STATS_CONFIG, useFactory: () => readEverStatsConfig(process.env) },
        { provide: INSTANCE_STATS_CLOCK, useValue: () => new Date() },
        { provide: INSTANCE_STATS_RANDOM, useValue: (max: number) => randomInt(0, max) },
        IsPlatformAdminGuard,
        SessionOnlyGuard,
        InstanceStatsOffMiddleware,
        InstanceStatsBuilderService,
        InstanceStatsSigner,
        InstanceStatsLeaseService,
        InstanceStatsSenderService,
        InstanceStatsSchedulerService,
        InstanceStatsService,
    ],
})
export class InstanceStatsModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(InstanceStatsOffMiddleware).forRoutes(InstanceStatsController);
    }
}

/**
 * What `ApiModule` imports for the statistics module: `[InstanceStatsModule]`
 * unless `EVER_STATS_ENABLED` switches it off, in which case NOTHING — no
 * route, no timer, no identity row, no client object.
 */
export function instanceStatsModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isEverStatsModuleEnabled(env) ? [InstanceStatsModule] : [];
}
