import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { AuthSessionGuard } from './auth/guards/auth-session.guard';
import { throttlerConfig } from './config/throttler.config';
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
import { OnboardingModule } from './onboarding/onboarding.module';
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
        ThrottlerModule.forRoot(throttlerConfig),
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
        ScreenshotModule,
        SearchModule,
        AgentPluginsModule.forRoot(),
        PluginsModule,
        GitProviderModule,
        OAuthModule,
        DeviceAuthModule,
        DeployModule,
        AiConversationModule,
        AccountModule,
        ActivityLogModule,
        OnboardingModule,
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
