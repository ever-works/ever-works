import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { AuthSessionGuard } from './auth/guards/auth-session.guard';
import { buildThrottlerConfig } from './config/throttler.config';
import { WorksModule } from './works/works.module';
import { KbStorageModule } from './uploads/kb-storage.module';
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
import { MissionsModule } from './missions/missions.module';
import { AgentsModule } from './agents/agents.module';
import { SkillsModule } from './skills/skills.module';
import { TasksModule } from './tasks/tasks.module';
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
        // KbStorageModule MUST be listed before WorksModule so the
        // @Global() KB_STORAGE_PLUGIN provider is registered before
        // KnowledgeBaseService's DI graph is resolved (WorksModule
        // imports KnowledgeBaseModule, which depends on the token).
        KbStorageModule,
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
        // Missions/Ideas/Works (spec 2026-05-24) — Phase 3 PR G:
        // skeleton module exposing GET /me/missions. CRUD + lifecycle
        // ship in PR H; Clone in PR HH; tick worker (Trigger.dev) in PR J.
        MissionsModule,
        // Agents/Skills/Tasks (PR #1017 specs) — Phase 3: AgentsService
        // + AgentsController. Heartbeat dispatcher + run service land in
        // Phase 6/7.
        AgentsModule,
        // Phase 8 — Skills read-only API + SkillsFacadeService.
        // Write paths + bindings ship with Phase 9.
        SkillsModule,
        // Phase 12 — Tasks API (CRUD + transitions + member CRUD).
        // Chat + attachments + per-task spend land in Phase 13.
        TasksModule,
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
