import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { FacadeExceptionFilter } from './common/filters/facade-exception.filter';
import { InsufficientCreditsExceptionFilter } from './common/filters/insufficient-credits.filter';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { AuthSessionGuard } from './auth/guards/auth-session.guard';
import { buildThrottlerConfig } from './config/throttler.config';
import { config } from './config/constants';
import { UserAwareThrottlerGuard } from './config/user-aware-throttler.guard';
import { WorksModule } from './works/works.module';
import { KbStorageModule } from './uploads/kb-storage.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MailModule } from './mail/mail.module';
import { EmailModule } from './email/email.module';
import { NotificationChannelsModule } from './notification-channels/notification-channels.module';
import { LoggingInterceptor } from './logging.interceptor';
import { MonitoringModule, SentryInterceptor, PostHogInterceptor } from '@ever-works/monitoring';
import { APIController } from './api.controller';
import { HealthModule } from './health/health.module';
import { TriggerInternalModule } from './trigger/trigger-internal.module';
import { GitHubAppModule, TwentyCrmModule } from './integrations';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { BillingApiModule } from './billing/billing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { BudgetsModule } from './budgets/budgets.module';
import { ScreenshotModule } from './plugins-capabilities/screenshot/screenshot.module';
import { SearchModule } from './plugins-capabilities/search/search.module';
import { TranscriptionModule } from './plugins-capabilities/transcription/transcription.module';
import { PluginsModule } from './plugins/plugins.module';
import { ComposioApiModule } from './plugins/composio/composio.module';
import { ComposioTriggersModule } from './plugins/composio-triggers/composio-triggers.module';
import { GitProviderModule } from './plugins-capabilities/git-provider/git-provider.module';
import { OAuthModule } from './plugins-capabilities/oauth/oauth.module';
import { DeviceAuthModule } from './plugins-capabilities/device-auth/device-auth.module';
import { DeployModule } from './plugins-capabilities/deploy/deploy.module';
import { AgentMemoryApiModule } from './plugins-capabilities/agent-memory/agent-memory.module';
import { AiConversationModule } from './ai-conversation/ai-conversation.module';
import { AccountModule } from './account/account.module';
import { ActivityLogModule } from './activity-log/activity-log.module';
import { DataSyncModule } from './data-sync/data-sync.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { TemplateCatalogModule } from './template-catalog/template-catalog.module';
import { WorkProposalsModule } from './work-proposals/work-proposals.module';
import { IdeaBuildExecutorDispatchModule } from './work-proposals/idea-build-executor-dispatch.module';
import { WorkAgentModule } from './work-agent/work-agent.module';
import { MissionsModule } from './missions/missions.module';
import { GoalsModule } from './goals/goals.module';
import { AgentsModule } from './agents/agents.module';
import { AgentApprovalsModule } from './agent-approvals/agent-approvals.module';
import { SkillsModule } from './skills/skills.module';
import { TasksModule } from './tasks/tasks.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { TerminalModule } from './terminal/terminal.module';
import { TeamsModule } from './teams/teams.module';
import { SchedulesModule } from './schedules/schedules.module';
import { InboundTriggersModule } from './triggers/inbound-triggers.module';
import { IngestModule } from './ingest/ingest.module';
import { MeetingsApiModule } from './meetings/meetings.module';
import { FleetApiModule } from './fleet/fleet.module';
import { MergePolicyApiModule } from './merge-policy/merge-policy.module';
import { ToolGrantsApiModule } from './tool-grants/tool-grants.module';
import { AgentCapabilitiesApiModule } from './agent-capabilities/agent-capabilities.module';
import { DigestApiModule } from './digest/digest.module';
import { EscalationsApiModule } from './escalations/escalations.module';
import { PrReviewApiModule } from './pr-review/pr-review.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { UsersModule } from './users/users.module';
import { ScopeModule } from './scope/scope.module';
import { ScopeOwnershipGuard } from './scope/scope-ownership.guard';
import { SessionScopeGuard } from './scope/session-scope.guard';
import { OrganizationsModule } from './organizations/organizations.module';
import { FunnelAnalyticsBindingModule } from './telemetry/funnel-analytics-binding.module';
import { UploadsModule } from './uploads/uploads.module';
import { MemoryFilesApiModule } from './memory-files/memory-files.module';
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
        // Standard Terminus health/readiness + build-version endpoints
        // (/api/version, /api/health/live, /api/health/ready). Additive —
        // the trivial /api/health + / in APIController are unchanged.
        HealthModule,
        AuthModule,
        // KbStorageModule MUST be listed before WorksModule so the
        // @Global() KB_STORAGE_PLUGIN provider is registered before
        // KnowledgeBaseService's DI graph is resolved (WorksModule
        // imports KnowledgeBaseModule, which depends on the token).
        KbStorageModule,
        WorksModule,
        MailModule,
        // Notifications v2 (EW-650 + EW-663) — additive surfaces. v1
        // MailModule + NotificationsModule above keep working unchanged.
        EmailModule,
        NotificationChannelsModule,
        TriggerInternalModule,
        SubscriptionsModule,
        NotificationsModule,
        BudgetsModule,
        ScreenshotModule,
        SearchModule,
        TranscriptionModule,
        AgentPluginsModule.forRootAsync({
            imports: [DatabaseModule],
            // EW-693 — wire dynamic-distribution config into the plugins
            // module. Default mode is `bundled` so a no-op deployment
            // behaves identically to pre-EW-693. The fail-fast validate()
            // throws when dynamic mode is selected without registry config.
            useFactory: () => {
                config.plugins.validate();
                return {
                    distributionMode: config.plugins.distributionMode(),
                    registryUrl: config.plugins.registryUrl(),
                    registryGithubUrl: config.plugins.registryGithubUrl(),
                    registryToken: config.plugins.registryToken(),
                    installDir: config.plugins.installDir(),
                };
            },
        }),
        PluginsModule,
        ComposioApiModule,
        ComposioTriggersModule,
        GitProviderModule,
        OAuthModule,
        DeviceAuthModule,
        DeployModule,
        AgentMemoryApiModule,
        AiConversationModule,
        AccountModule,
        ActivityLogModule,
        DataSyncModule,
        OnboardingModule,
        TemplateCatalogModule,
        WorkProposalsModule,
        // PR-4 — @Global binding of the Idea build executor dispatch
        // adapter (inert until EVER_WORKS_IDEA_BUILD_EXECUTOR_ENABLED=true).
        IdeaBuildExecutorDispatchModule,
        WorkAgentModule,
        // Missions/Ideas/Works (spec 2026-05-24) — Phase 3 PR G:
        // skeleton module exposing GET /me/missions. CRUD + lifecycle
        // ship in PR H; Clone in PR HH; tick worker (Trigger.dev) in PR J.
        MissionsModule,
        // Goals & Metrics (PR-8) — user-owned measurable targets
        // evaluated against metrics-provider plugins (PR-7). CRUD +
        // lifecycle + evaluate-now on /api/me/goals; Mission link
        // endpoints live on the MissionsController.
        GoalsModule,
        // Agents/Skills/Tasks (PR #1017 specs) — Phase 3: AgentsService
        // + AgentsController. Heartbeat dispatcher + run service land in
        // Phase 6/7.
        AgentsModule,
        // Agent Action Approval Queue — human-in-the-loop gate for
        // side-effectful Agent actions. GET queue + approve/reject.
        AgentApprovalsModule,
        // Phase 8 — Skills read-only API + SkillsFacadeService.
        // Write paths + bindings ship with Phase 9.
        SkillsModule,
        // Phase 12 — Tasks API (CRUD + transitions + member CRUD).
        // Chat + attachments + per-task spend land in Phase 13.
        TasksModule,
        // Saved workflow graphs (judgment layer G5) — the persistence and
        // CRUD surface for graphs the executor could already run but
        // nothing could keep.
        WorkflowsModule,
        // Streaming-terminal M3 — relay registry + WS gateway on this
        // process's HTTP server + attach-token/internal-publish endpoints.
        TerminalModule,
        // Teams & Prebuilt Companies — org-nested Teams CRUD + Org Chart
        // (docs/specs/features/teams-and-companies/spec.md §3).
        TeamsModule,
        // Schedules ("Cadence") — read-only aggregation of every
        // user-owned scheduled source into GET /api/schedules. Additive;
        // reuses existing entity tables (no new schema).
        SchedulesModule,
        // Inbound Triggers ("Trigger Schedules") — signed webhook/API
        // triggers that spawn Tasks on verified HMAC deliveries.
        // Management CRUD + the public /:id/fire endpoint.
        InboundTriggersModule,
        // Event-ingest spine (Wave 6) — POST /api/ingest/events push
        // surface over the agent-side EventIngestModule (dedupe-insert +
        // Activity/Memory fan-out; pull rides the event-ingest-tick cron).
        IngestModule,
        // Meetings v1 (Wave 8, feature a) — /api/meetings CRUD +
        // transcript capture over the agent-side MeetingsModule; also
        // boots the zoom.recording envelope→Meeting processor on the
        // ingest spine.
        MeetingsApiModule,
        // Fleet (Wave 12, slice 1) — /api/fleet node registry (owner
        // CRUD-lite + public token-authenticated enroll/heartbeat) over
        // the agent-side FleetModule.
        FleetApiModule,
        // Merge-policy matrix (Wave 3, founder decision D4) —
        // GET /api/merge-policy/resolve owner-scoped preview over the
        // agent-side PolicyModule. Writes ride the existing Work / Agent /
        // organization PATCH endpoints.
        MergePolicyApiModule,
        // Tool-grant matrix (audit item G4) — owner-scoped resolve/check
        // preview plus the write path for the per-scope grant rows. Same
        // ownership checks as the merge-policy preview; grants are their
        // own rows, so unlike a merge policy they need a write path here.
        ToolGrantsApiModule,
        // Capabilities tab — composed per-Agent read (catalog + grants +
        // permissions + init script). Additive leaf over the two above.
        AgentCapabilitiesApiModule,
        // Digest read (Wave 7) — GET /api/digest owner-scoped composed
        // digest over the agent-side DigestModule. Cadence stays a
        // profile preference; delivery stays on the digest-dispatcher
        // cron. Exists so the `get_digest` chat tool has a REST operation
        // the manifest-driven web tool registry can bind to.
        DigestApiModule,
        // Judgment layer G3/G10 — /api/escalations, the cross-Task
        // "what is waiting on me?" queue over the agent-side
        // AgentEscalationService. The Task-scoped escalation routes on
        // TasksController stay exactly as they are; this is the read
        // that made escalations reachable without already knowing which
        // Task to open.
        EscalationsApiModule,
        // AI PR review (Wave 7) — POST /api/pr-review owner-scoped
        // trigger over the agent-side PrReviewModule, the third REST
        // operation the web tool registry was missing. Refuses any
        // repository not connected to one of the caller's own Works.
        PrReviewApiModule,
        // The money path (billing PRD B5) — /api/credits/checkout,
        // /api/billing/{overview,invoices,auto-recharge} and the
        // signature-verified /api/billing/webhook over the agent-side
        // BillingService + BillingProvider seam. Additive beside the
        // read-only credits surface in SubscriptionsModule.
        BillingApiModule,
        TelemetryModule,
        FunnelAnalyticsBindingModule,
        UploadsModule,
        // Memory Files — /api/memory/files: the unified Files area of
        // /memory (folder tree + both upload spines + manual git sync).
        MemoryFilesApiModule,
        WebhooksModule,
        // EW-652 (Tenants & Organizations Phase 0) — UsersModule provides
        // `UsernameAllocatorService` (consumed by AuthModule callers,
        // OnboardingModule, GitHubAppModule) and the public
        // `GET /api/users/check-username` endpoint.
        UsersModule,
        // EW-657 (Tenants & Organizations Phase 5b) — global
        // ScopeContextService + TypeORM subscriber that auto-stamps
        // `tenantId` / `organizationId` on Tier A/C inserts. No-op
        // until Phase 7's slug-resolver middleware populates the
        // request scope.
        ScopeModule,
        // EW-658 (Tenants & Organizations Phase 6) — Organization
        // CRUD + lazy Tenant bootstrap + upgrade-from-account flow.
        OrganizationsModule,
    ],
    providers: [
        {
            provide: APP_GUARD,
            useClass: AuthSessionGuard,
        },
        // EW-664 (Phase 12) — runs AFTER AuthSessionGuard (guard order
        // matches providers-array order) so request.user is set, and
        // BEFORE ScopeOwnershipGuard so the ownership check sees the
        // seeded scope. Falls back to the authenticated user's default
        // scope (their Tenant + last-active Org) on legacy un-prefixed
        // routes where no slug resolved a scope. No-op for slug routes
        // (scope already set) and unauthenticated requests.
        {
            provide: APP_GUARD,
            useClass: SessionScopeGuard,
        },
        // EW-659 (Phase 7) — runs AFTER AuthSessionGuard (guard order
        // matches providers-array order) so request.user is set. Rejects
        // a scope mismatch with 403 to prevent cross-tenant access via
        // slug. Runs after SessionScopeGuard so it sees the seeded scope
        // (which is the user's own Tenant — passes trivially).
        {
            provide: APP_GUARD,
            useClass: ScopeOwnershipGuard,
        },
        {
            provide: APP_GUARD,
            useClass: UserAwareThrottlerGuard,
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
        // Maps the `@ever-works/agent` FacadeError hierarchy (git / deploy /
        // oauth / content-extractor "no provider / not connected / not found"
        // errors) to the correct 4xx instead of the generic 500 Nest's
        // default filter would emit. Additive: only nets FacadeErrors that
        // reach a controller UNCAUGHT (e.g. POST /api/templates/fork →
        // NoGitProviderError). See facade-exception.filter.ts.
        {
            provide: APP_FILTER,
            useClass: FacadeExceptionFilter,
        },
        // Maps credit-balance exhaustion (`InsufficientCreditsError`, thrown
        // by CreditLedgerService when a debit would cross zero and overdraft
        // is off) to 402 Payment Required instead of the generic 500 Nest's
        // default filter would emit — matching the 402 the budget cap already
        // uses (BudgetExceededException). Body is a constant: the error's own
        // message and fields carry the owner's userId and balance, which are
        // never echoed. See insufficient-credits.filter.ts.
        {
            provide: APP_FILTER,
            useClass: InsufficientCreditsExceptionFilter,
        },
    ],
    controllers: [APIController],
})
export class ApiModule implements OnApplicationBootstrap {
    constructor(private readonly pluginBootstrap: PluginBootstrapService) {}

    /**
     * Called after all modules have been initialized.
     * This is the single point where plugins are loaded.
     *
     * EW-693 / FR-13a — In dynamic mode (PLUGIN_DISTRIBUTION_MODE=dynamic)
     * we also pre-install the DB-recorded distributable plugin set on
     * this pod's local store so the first request after boot doesn't pay
     * the install cost. `warmupDynamicPlugins()` is an internal no-op in
     * bundled mode, and failures are logged but never rethrown — lazy
     * install-on-use (FR-13) is the correctness mechanism, warmup is
     * optimisation only. We run warmup BEFORE the API begins serving so
     * the readiness probe in k8s flips green only after the store is
     * primed (`startupProbe.initialDelaySeconds` covers the worst-case
     * warmup time; see `.deploy/k8s/k8s-manifest.prod.yaml`).
     */
    async onApplicationBootstrap(): Promise<void> {
        await this.pluginBootstrap.bootstrap();
        await this.pluginBootstrap.warmupDynamicPlugins();
    }
}
