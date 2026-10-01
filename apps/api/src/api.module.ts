import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { FacadeExceptionFilter } from './common/filters/facade-exception.filter';
import { InsufficientCreditsExceptionFilter } from './common/filters/insufficient-credits.filter';
import { SeatLimitExceptionFilter } from './common/filters/seat-limit.filter';
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
import { NotificationEmailModule } from './notifications/notification-email.module';
import { ChangelogModule } from './changelog/changelog.module';
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
// APW-11 (App Launcher) — the registry routes: GET/PUT /api/me/apps and the
// public GET /api/app-launcher/platforms. Every one of them answers the same
// opaque 404 unless EVER_WORKS_APP_LAUNCHER_ENABLED is 'true' (FR-54).
import { AppLauncherModule } from './app-launcher/app-launcher.module';
import { MissionsModule } from './missions/missions.module';
import { GoalsModule } from './goals/goals.module';
import { AgentsModule } from './agents/agents.module';
import { RunsModule } from './runs/runs.module';
import { ModelRoutingApiModule } from './model-routing/model-routing.module';
import { EnvironmentsApiModule } from './environments/environments.module';
import { AgentApprovalsModule } from './agent-approvals/agent-approvals.module';
import { SkillsModule } from './skills/skills.module';
import { AgentPluginsApiModule } from './agent-plugins/agent-plugins.module';
import { McpConnectionsModule } from './mcp-connections/mcp-connections.module';
import { RepoConnectionsModule } from './repo-connections/repo-connections.module';
import { TasksModule } from './tasks/tasks.module';
import { ReleaseModule } from './release/release.module';
import { TaskTemplatesModule } from './task-templates/task-templates.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { CatalogModule } from './catalog/catalog.module';
import { TerminalModule } from './terminal/terminal.module';
import { ComputerApiModule } from './computer/computer.module';
import { TeamsModule } from './teams/teams.module';
import { SchedulesModule } from './schedules/schedules.module';
import { HomeModule } from './home/home.module';
import { WorkspaceSearchModule } from './workspace-search/workspace-search.module';
import { InboundTriggersModule } from './triggers/inbound-triggers.module';
import { IngestModule } from './ingest/ingest.module';
import { MeetingsApiModule } from './meetings/meetings.module';
import { FleetApiModule } from './fleet/fleet.module';
import { MergePolicyApiModule } from './merge-policy/merge-policy.module';
import { ToolGrantsApiModule } from './tool-grants/tool-grants.module';
import { AgentCapabilitiesApiModule } from './agent-capabilities/agent-capabilities.module';
import { DigestApiModule } from './digest/digest.module';
import { EscalationsApiModule } from './escalations/escalations.module';
import { InboxApiModule } from './inbox/inbox.module';
import { PrReviewApiModule } from './pr-review/pr-review.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { UsersModule } from './users/users.module';
import { ScopeModule } from './scope/scope.module';
import { ScopeOwnershipGuard } from './scope/scope-ownership.guard';
import { SessionScopeGuard } from './scope/session-scope.guard';
import { OrganizationsModule } from './organizations/organizations.module';
import { SharedViewsApiModule } from './shared-views/shared-views.module';
import { SafetyApiModule } from './safety/safety.module';
import { FunnelAnalyticsBindingModule } from './telemetry/funnel-analytics-binding.module';
import { AppWorksTelemetryBindingModule } from './telemetry/app-works-telemetry-binding.module';
import { UploadsModule } from './uploads/uploads.module';
import { MemoryFilesApiModule } from './memory-files/memory-files.module';
import { MemoryFactsApiModule } from './memory-facts/memory-facts.module';
import { VectorStoreHostChunkTablesModule } from '@ever-works/agent/services';
import { KnowledgeLibraryApiModule } from './knowledge-library/knowledge-library.module';
import { WebhooksModule } from './webhooks/webhooks.module';
// APW-02 (Fork lifecycle) — the three Upstream routes of plan §4.1
// (`GET/POST /api/works/:id/upstream…`). Every one of them answers through the
// agent package's AppUpstreamStateService, and each refusal travels as §4.1's
// `{ status: 'error', code, message, details? }` body.
import { AppWorksModule } from './app-works/app-works.module';
// APW-05 T21 (first slice) — the API-side Builds module: today the two-minute
// Builds sweep when Trigger.dev is not the runtime (plan §7.4). T23/T24 extend it.
import { AppBuildsModule } from './app-builds/app-builds.module';
// APW-09 T43 (FR-43, XC-18) — the credential of record: the read, the pause, the
// handover, and the durable store the handover writes. Agent-side, so the whole
// epic's later routes reach it by importing the agent module directly.
import { UpstreamPullRequestsModule } from '@ever-works/agent/upstream-pull-requests';
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
        // AW-13 Attention controls — binds the built-in `email` delivery
        // target (a @Global() port consumed by the channel facade).
        NotificationEmailModule,
        // AW-14 What's new — in-product product changelog: entries from the
        // build's content source, per-person read state, /api/changelog.
        ChangelogModule,
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
                    // EW-693 T27 — bounds the boot warmup (default 60 s).
                    warmupTimeoutMs: config.plugins.warmupTimeoutMs(),
                    // EW-693 T26 — both OFF unless set (today's behaviour).
                    facadeInstallOnUse: config.plugins.facadeInstallOnUse(),
                    sandboxSessionsViaJobRuntime: config.plugins.sandboxSessionsViaJobRuntime(),
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
        // APW-11 (App Launcher) — additive: one module, three routes, all of
        // them behind AppLauncherEnabledGuard. Nothing above or below moves.
        AppLauncherModule,
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
        // Runs ledger + run receipt (AW-09) — GET /api/runs*: the
        // calendar-navigated ledger of every Agent run and the itemised
        // receipt of one, over the same run rows the Sessions endpoints read.
        RunsModule,
        // Model accounts (AW-16) — /api/model-accounts and /api/model-policies:
        // several credentials per AI provider, in order, and the workspace /
        // Agent / schedule model ladder. The planner the AI facade consults is
        // bound through FacadesModule, not here.
        ModelRoutingApiModule,
        // Environments (Settings → Environments) — named, reusable
        // runtime recipes (packages + networking) assigned per-Agent.
        EnvironmentsApiModule,
        // Agent Action Approval Queue — human-in-the-loop gate for
        // side-effectful Agent actions. GET queue + approve/reject.
        AgentApprovalsModule,
        // Phase 8 — Skills read-only API + SkillsFacadeService.
        // Write paths + bindings ship with Phase 9.
        SkillsModule,
        AgentPluginsApiModule,
        // Agent Plugins MCP slice — manual external MCP connections +
        // per-agent bindings (docs/specs/features/agent-plugins §2.3).
        McpConnectionsModule,
        // Repository registry (Feature G) — Settings → Repositories CRUD,
        // GitHub-App import, and the Agent ↔ repo attachment surface.
        RepoConnectionsModule,
        // Phase 12 — Tasks API (CRUD + transitions + member CRUD).
        // Chat + attachments + per-task spend land in Phase 13.
        TasksModule,
        // Tasks upgrades — workflow Task Templates (CRUD + instantiate).
        TaskTemplatesModule,
        // Release promotion lane (self-build slice AI, EW-808) — the
        // operator surface for develop -> stage -> main, and the import
        // that BINDS the @Global() PROMOTION_MERGE_GUARD /
        // PROMOTION_LANE_WATCHER tokens `TaskMergeGateService` and
        // `TaskPrStatusService` consume. Removing it does not open a hole:
        // the merge gate refuses a promotion Task whose guard is unbound.
        ReleaseModule,
        // Saved workflow graphs (judgment layer G5) — the persistence and
        // CRUD surface for graphs the executor could already run but
        // nothing could keep.
        WorkflowsModule,
        // Capability & playbook catalogue (AW-21) — read-only playbook list,
        // detail and preflight over enabled playbook-provider plugins.
        CatalogModule,
        // Streaming-terminal M3 — relay registry + WS gateway on this
        // process's HTTP server + attach-token/internal-publish endpoints.
        TerminalModule,
        // Agent computers (watch) — live views of the machine an Agent works
        // on: owner session routes, node publish routes, a relay and a WS
        // gateway sharing this process's HTTP server with the terminal's.
        // Rides the terminal's attach-token signer and the fleet's node
        // auth and job runtime; dark with FLEET_ENABLED=false.
        ComputerApiModule,
        // Teams & Prebuilt Companies — org-nested Teams CRUD + Org Chart
        // (docs/specs/features/teams-and-companies/spec.md §3).
        TeamsModule,
        // Schedules ("Cadence") — read-only aggregation of every
        // user-owned scheduled source into GET /api/schedules. Additive;
        // reuses existing entity tables (no new schema).
        SchedulesModule,
        // Home (AW-19) — read-only GET /api/home/summary: the morning read
        // composed from decisions, the Runs ledger, schedules, costs and the
        // Live Feed, one status per block. Additive; no new schema.
        HomeModule,
        // Workspace search (AW-01) — read-only GET /api/workspace-search
        // behind the dashboard command palette. Additive; reads existing
        // entity tables (no new schema).
        WorkspaceSearchModule,
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
        // Inbox (operator message center) — /api/inbox over the
        // agent-side InboxModule, plus the @Global() INBOX_PRODUCER
        // binding that makes escalations / pending proposals / budget
        // alerts mirror into the human's inbox.
        InboxApiModule,
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
        AppWorksTelemetryBindingModule,
        UploadsModule,
        // Memory Files — /api/memory/files: the unified Files area of
        // /memory (folder tree + both upload spines + manual git sync).
        MemoryFilesApiModule,
        // Memory facts (AW-07) — /api/memory/facts: the atomic tier of
        // Memory (list / search by meaning / edit / forget / restore).
        // The embed dispatcher resolves through the job-runtime provider
        // registry (TriggerModule), so any configured runtime runs it.
        MemoryFactsApiModule,
        // AW-07 — publishes the platform vector chunk tables to the plugin
        // host, so the bundled pgvector store actually serves the Knowledge
        // Base (work_knowledge_chunks) and memory facts
        // (vector_namespace_chunks) instead of failing "not wired".
        VectorStoreHostChunkTablesModule,
        // Knowledge library — /api/knowledge: the organization shelf over
        // the Knowledge Base (shared folders, filing, archive / restore,
        // Markdown export).
        KnowledgeLibraryApiModule,
        WebhooksModule,
        // APW-02 (Fork lifecycle) — additive: one module, three routes, all of
        // them behind the global session guard and the per-Work visibility check
        // the agent service performs. It also re-exports the agent package's
        // AppWorksModule, which is what `TriggerInternalModule` imports for its
        // remote-proxy targets (T27/T28). Nothing above or below moves.
        AppWorksModule,
        // APW-05 T21 (first slice) — additive: `AppBuildSweepCronService`, the Builds
        // sweep from this process when Trigger.dev is not the runtime (its `@Cron`
        // fires through `ScheduleModule.forRoot()` above). Nothing above or below moves.
        AppBuildsModule,
        // APW-09 T43 (FR-43, XC-18) — additive: the credential of record. The
        // module provides `UpstreamCredentialService` and the durable store a
        // handover writes, and binds `UPSTREAM_CREDENTIAL_STORE` to it, so a
        // handover records on `work_upstream_states.credentialMemberUserId`
        // instead of failing closed with `handover_unavailable`. Its controller
        // route (T43's `POST /api/works/:id/upstream/credential/handover`) is
        // APW-09's own remaining work; the module is registered here so the
        // binding is in the graph the API boots with. Nothing above or below
        // moves.
        UpstreamPullRequestsModule,
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
        // AW-18 Shared view — Settings → Sharing (owner) and the public
        // share-link exchange + published board read (no account).
        SharedViewsApiModule,
        // AW-24 Safety rails — the trust ladder, the refusal log and the one
        // enforcement point every side-effectful action passes through.
        SafetyApiModule,
    ],
    providers: [
        {
            provide: APP_GUARD,
            useClass: AuthSessionGuard,
        },
        // EW-664 (Phase 12) — runs AFTER AuthSessionGuard (guard order
        // matches providers-array order) so request.user is set, and
        // BEFORE ScopeOwnershipGuard so the ownership check sees the
        // seeded scope. On unprefixed routes where no slug resolved a
        // scope it seeds the authenticated user's Tenant and leaves the
        // Organization NULL — since 8f28edca0 it deliberately does not
        // fall back to their last-active Org, so an unprefixed request is
        // the personal contract. No-op for slug routes (scope already set)
        // and unauthenticated requests.
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
        // Same treatment for a full seat allowance (`SeatLimitExceededError`,
        // thrown by SeatsService when inviting a member or creating an agent
        // would exceed included + purchased seats): 402, not a 500, because
        // the caller resolves it by buying a seat or freeing one. See
        // seat-limit.filter.ts (billing spec §3.6).
        {
            provide: APP_FILTER,
            useClass: SeatLimitExceptionFilter,
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
     * warmup time; see `.deploy/k8s/k8s-manifest.prod.yaml`). Each plugin's
     * fetch is bounded by `PLUGIN_WARMUP_TIMEOUT_MS` (default 60 s; EW-693
     * T27), so a hanging registry cannot hold the boot indefinitely.
     */
    async onApplicationBootstrap(): Promise<void> {
        await this.pluginBootstrap.bootstrap();
        await this.pluginBootstrap.warmupDynamicPlugins();
    }
}
