import { Module, Global } from '@nestjs/common';
import { SentryModule } from './sentry/sentry.module';
import { PostHogModule } from './posthog/posthog.module';
import { AnalyticsService } from './services/analytics.service';
import { SentryService } from './services/sentry.service';
import { MonitoringConfig } from './types';

@Global()
@Module({})
export class MonitoringModule {
    static forRoot(config?: MonitoringConfig) {
        return {
            module: MonitoringModule,
            global: true,
            imports: [SentryModule.forRoot(config?.sentry), PostHogModule.forRoot(config?.posthog)],
            providers: [AnalyticsService, SentryService],
            exports: [AnalyticsService, SentryService],
        };
    }
}
