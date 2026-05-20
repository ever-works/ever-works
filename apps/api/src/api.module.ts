import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { AuthSessionGuard } from './auth/guards/auth-session.guard';
import { buildThrottlerConfig } from './config/throttler.config';
import { WorksModule } from './works/works.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MailModule } from './mail/mail.module';
import { LoggingInterceptor } from './logging.interceptor';
import { MonitoringModule, SentryInterceptor, PostHogInterceptor } from '@ever-works/monitoring';
import { APIController } from './api.controller';
import { TriggerInternalModule } from './trigger/trigger-internal.module';
import { GitHubAppModule, TwentyCrmModule } from './integrations';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { NotificationsModule } from './notifications/notifications.module';
import { BudgetsModule } from './budgets/budgets.module';
import { ScreenshotModule } from './plugins-capabilities/screenshot/screenshot.module';
import { SearchModule } from './plugins-capabilities/search/search.module';
import { PluginsModule } from './plugins/plugins.module';
import { GitProviderModule } from './plugins-capabilities/git-provider/git-provider.module';
import { OAuthModule } from './plugins-capabilities/oauth/oauth.module';
import { DeviceAuthModule } from './plugins-capabilities/device-auth/device-auth.module';
import { DeployModule } from './plugins-capabilities/deploy/deploy.module';
import { AiConversationModule } from './ai-conversation/ai-conversation.module';
import { AccountModule } from './account/account.module';
import { ActivityLogModule } from './activity-log/activity-log.module';
import { DataSyncModule } from './data-sync/data-sync.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { TemplateCatalogModule } from './template-catalog/template-catalog.module';
import { WorkProposalsModule } from './work-proposals/work-proposals.module';
import { WorkAgentModule } from './work-agent/work-agent.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { FunnelAnalyticsBindingModule } from './telemetry/funnel-analytics-binding.module';
import { UploadsModule } from './uploads/uploads.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import {
    PluginsModule as AgentPluginsModule,
    PluginBootstrapService,
} from '@ever-works/agent/plugins';
import { CacheFactory } from '@ever-works/agent/cache';
import { DatabaseModule } from '@ever-works/agent/database';

@Module({
    imports: [
        DatabaseModule,
        CacheFactory.TypeORM({
            isGlobal: true,
        }),
        ScheduleModule.forRoot(),
        TwentyCrmModule.forRoot(),
        GitHubAppModule,
        // H-17/H-18: distributed throttler when THROTTLER_REDIS_URL is set,
        // in-memory fallback otherwise. `forRootAsync` so the dynamic import
        // of @nest-lab/throttler-storage-redis can resolve at bootstrap.
        ThrottlerModule.forRootAsync({
            useFactory: () => buildThrottlerConfig(),
        }),
        EventEmitterModule.forRoot(),
        MonitoringModule.forRoot({
            sentry: {
                dsn: process.env.SENTRY_DSN,
                environment: process.env.NODE_ENV || 'development',
            },
            posthog: {
                apiKey: process.env.POSTHOG_API_KEY,
                host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
            },
        }),
        AuthModule,
        WorksModule,
        MailModule,
        TriggerInternalModule,
        SubscriptionsModule,
        NotificationsModule,
        BudgetsModule,
        ScreenshotModule,
        SearchModule,
        AgentPluginsModule.forRootAsync({
            imports: [DatabaseModule],
            useFactory: () => ({}),
        }),
        PluginsModule,
        GitProviderModule,
        OAuthModule,
        DeviceAuthModule,
        DeployModule,
        AiConversationModule,
        AccountModule,
        ActivityLogModule,
        DataSyncModule,
        OnboardingModule,
        TemplateCatalogModule,
        WorkProposalsModule,
        WorkAgentModule,
        TelemetryModule,
        FunnelAnalyticsBindingModule,
        UploadsModule,
        WebhooksModule,
    ],
    providers: [
        {
            provide: APP_GUARD,
            useClass: AuthSessionGuard,
        },
        {
            provide: APP_GUARD,
            useClass: ThrottlerGuard,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: LoggingInterceptor,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: SentryInterceptor,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: PostHogInterceptor,
        },
    ],
    controllers: [APIController],
})
export class ApiModule implements OnApplicationBootstrap {
    constructor(private readonly pluginBootstrap: PluginBootstrapService) {}

    /**
     * Called after all modules have been initialized.
     * This is the single point where plugins are loaded.
     */
    async onApplicationBootstrap(): Promise<void> {
        await this.pluginBootstrap.bootstrap();
    }
}
