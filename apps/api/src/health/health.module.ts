import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { ConfiguredServiceHealthIndicator } from './indicators/configured-service.indicator';

/**
 * Health + version module (additive — does not touch the existing trivial
 * `/api/health` / `/` in APIController).
 *
 * `TerminusModule` supplies `HealthCheckService`, `HealthIndicatorService`
 * and `TypeOrmHealthIndicator`. The Typeorm indicator resolves the default
 * `DataSource`, which is registered globally by `DatabaseModule`'s
 * `TypeOrmModule.forRootAsync`, so no extra imports are needed here.
 */
@Module({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [RedisHealthIndicator, ConfiguredServiceHealthIndicator],
})
export class HealthModule {}
