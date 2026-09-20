import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@ever-works/agent/database';
import { CacheEntry } from '@ever-works/agent/entities';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { TriggerInternalController } from './trigger-internal.controller';
import { WorkOperationsModule } from '@ever-works/agent/work-operations';
import { KnowledgeBaseModule, MemoryFactsModule, WorkModule } from '@ever-works/agent/services';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { FacadesModule } from '@ever-works/agent/facades';
import { MissionsModule } from '@ever-works/agent/missions';
import { WorkAgentModule } from '@ever-works/agent/work-agent';
import { GoalsModule } from '@ever-works/agent/goals';
import { AgentsModule, TerminalTranscriptModule } from '@ever-works/agent/agents';
import { TasksDomainModule } from '@ever-works/agent/tasks-domain';
import { ConversationsModule } from '@ever-works/agent/conversations';
import { EventIngestModule } from '@ever-works/agent/ingest';
import { DigestModule } from '@ever-works/agent/digest';
import { SubscriptionsModule as AgentSubscriptionsModule } from '@ever-works/agent/subscriptions';
import { FleetModule as AgentFleetModule } from '@ever-works/agent/fleet';
import { ModelRoutingModule } from '@ever-works/agent/model-routing';
import { SkillsModule as AgentSkillsModule } from '@ever-works/agent/skills';
import { AccountTransferModule } from '@ever-works/agent/account-transfer';
import { WorkProposalsModule } from '../work-proposals/work-proposals.module';
import { DataSyncModule } from '../data-sync/data-sync.module';
import { TenantJobRuntimeModule } from '../account/tenant-job-runtime/tenant-job-runtime.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AppWorksModule } from '../app-works/app-works.module';
// APW-03 T12/T13 — the App spec service, exposed through the remote-proxy
// controller (APW-02 T28 wired the entry).
import { AppSpecModule } from '@ever-works/agent/app-spec';
// APW-05 T19 + C7 — the App Builds module, so the `app-build-prepare` job's
// runner is resolvable in the API process, where the `DataSource`, the lock's
// `cache_entries` row and the Activity writer live. The task resolves the runner
// over the internal RPC channel (`app-build-prepare.task.ts`), because a Trigger
// worker owns no `DataSource`; this import is the API half of that pair. Without
// it the controller's constructor cannot take the runner and every dispatch
// reports `runnerUnavailable` while §7.1's in-process fallback hides the gap on
// the local stack only. `AppBuildsModule` imports `DatabaseModule` itself, which
// is what its `DistributedTaskLockService` needs.
import { AppBuildsModule } from '@ever-works/agent/app-builds';

@Module({
    imports: [
        // EW-742 P3.2 T22 — DatabaseModule exports
        // WebhookSubscriptionRepository (proxied through the
        // remote-proxy controller for the webhook-delivery task's
        // resolveForSubscription path).
        DatabaseModule,
        WorkOperationsModule,
        WorkModule,
        NotificationsModule,
        FacadesModule,
        WorkProposalsModule,
        // EW-742 P3.2 T22 — exposes CredentialVersionService through the
        // remote-proxy controller so the Trigger.dev worker can verify
        // the (providerId, credentialVersion) pair stamped at enqueue time.
        TenantJobRuntimeModule,
        // EW-742 P3.2 T22 — exposes OrganizationRepository for the
        // resolveForOrganization path on the worker-host resolver.
        OrganizationsModule,
        // EW-628 G7 — exposes DataSyncDispatcherService through the
        // remote-proxy controller so the Trigger.dev worker can call it
        // each cron tick without importing the full API stack.
        DataSyncModule,
        // EW-641 — exposes WorkKnowledgeDocumentRepository through the
        // remote-proxy controller so the KB mirror Trigger.dev task can
        // read + update document rows without direct DB access from
        // worker scope.
        KnowledgeBaseModule,
        // Phase 3 PR J — exposes MissionTickService through the
        // remote-proxy controller so the mission-tick cron task (in
        // packages/tasks) can call tickDue() each minute without
        // direct DB access from worker scope.
        MissionsModule,
        // PR-4 — exposes IdeaBuildExecutorService through the
        // remote-proxy controller so the idea-build-execute one-shot
        // task (in packages/tasks) can drive executeBuild() over the
        // internal RPC channel without direct DB access from worker
        // scope. WorkAgentModule exports the service.
        WorkAgentModule,
        // Goals & Metrics PR-8 — exposes GoalEvaluationService through
        // the remote-proxy controller so the goal-evaluate-dispatcher
        // cron task (in packages/tasks) can call evaluateDue() each
        // minute without direct DB access from worker scope.
        GoalsModule,
        // Agents/Skills/Tasks PR #1017 — Phase 6. Exposes
        // AgentScheduleDispatcherService + AgentRepository +
        // AgentRunRepository through the remote-proxy controller so
        // the agent-heartbeat dispatcher + worker can drive them
        // without direct DB access from worker scope.
        AgentsModule,
        // Agents/Skills/Tasks PR #1017 — Phase 17. Exposes
        // TaskRecurrenceDispatcherService through the remote-proxy
        // controller so the task-recurrence-dispatcher cron task
        // can drive `dispatchDue()` over the internal RPC channel.
        TasksDomainModule,
        // Event-ingest spine (Wave 6) — exposes EventIngestService
        // through the remote-proxy controller so the event-ingest-tick
        // cron task (in packages/tasks) can drive `processBatch()` over
        // the internal RPC channel every 5 minutes.
        EventIngestModule,
        // Digest briefings (Wave 7) — exposes DigestService through the
        // remote-proxy controller so the digest-dispatcher cron task
        // (in packages/tasks) can drive `dispatchDue(period)` over the
        // internal RPC channel each morning.
        DigestModule,
        // Credits ledger (pricing Wave 9 M1) — exposes CreditLedgerService
        // through the remote-proxy controller so the credits-daily-grant
        // cron task (in packages/tasks) can drive `dispatchDailyGrants()`
        // over the internal RPC channel once a day.
        AgentSubscriptionsModule,
        // Streaming-terminal M9 / founder decision D1 — exposes
        // TerminalTranscriptService through the remote-proxy controller
        // so the terminal-transcript-gc cron task (in packages/tasks)
        // can drive `sweepExpired()` over the internal RPC channel each
        // night, pruning each run's transcript to its plan-tier window.
        TerminalTranscriptModule,

        // Fleet job runtime (Desktop PRD M4) — exposes FleetJobService
        // through the remote-proxy controller so the
        // fleet-job-lease-sweeper cron task (in packages/tasks) can drive
        // `reclaimExpired()` over the internal RPC channel. Reclaim also
        // runs inline on every node lease poll; the cron is what makes a
        // fleet whose nodes ALL died still converge.
        AgentFleetModule,
        // Memory facts (AW-07) — exposes MemoryFactEmbedService and
        // MemoryFactSweepService through the remote-proxy controller so the
        // memory-fact-embed task and the memory-fact-gc cron (in
        // packages/tasks) run here, where the AI provider and vector-store
        // plugins are loaded.
        MemoryFactsModule,
        // Model accounts (AW-16) — exposes ModelAccountHealthService through
        // the remote-proxy controller so the model-account-health cron task
        // (in packages/tasks) can drive `probeDueAccounts()` over the
        // internal RPC channel, where the AI provider plugins are loaded.
        ModelRoutingModule,
        // Skills shelf — exposes SkillReadinessService through the
        // remote-proxy controller so the skill-readiness-sweep cron task (in
        // packages/tasks) can drive `sweepStale()` over the internal RPC
        // channel every hour.
        AgentSkillsModule,
        // Named Conversations — exposes ConversationMessageService through
        // the remote-proxy controller so the agent-conversation-reply task
        // (in packages/tasks) can load the Conversation it answers and
        // record the Agent's reply over the internal RPC channel.
        ConversationsModule,
        // APW-02 T28 — exposes the App upstream trio through the remote-proxy
        // controller: AppUpstreamStateService (the readiness/sync jobs' claim,
        // probes and the conflict Task), AppUpstreamSyncDispatcherService (the
        // `app-upstream-sync-dispatcher` cron's `dispatchDue()`) and
        // WorkUpstreamStateRepository (the sync run's read of the epic's own
        // row — T26 reported this binding by name). The API-side AppWorksModule
        // re-exports the agent one, so this single import resolves all three.
        AppWorksModule,
        // APW-03 T12/T13 — exposes AppSpecService through the remote-proxy
        // controller so the worker-side `app.spec.*` calls land here, where the
        // App-spec state row, the git facade and the Activity log are wired
        // (APW-02 T28 wired this entry at the packaging owner's request).
        AppSpecModule,
        // APW-05 T19 + C7 — exposes `AppBuildPrepareRunner` through the remote-proxy
        // controller, so the `app-build-prepare` job can run the §7.2 prepare where the
        // `DataSource` is. T19 landed the runner, the job and its module binding, and
        // reported this registration by name: with the token unbound in the worker and
        // the name absent here, the proxy's call rejects and the run reports
        // `status: 'failed'`, `reason: 'runnerUnavailable'` — a named failure, but the
        // queued path would never work. Appended as its own import rather than folded
        // into AppWorksModule because the two epics' modules are separate graphs.
        AppBuildsModule,
        // APW-06 T71 — `DistributedTaskLockService` is provided by THIS module (below) for the
        // controller's remote target of the same name, and it needs its repository: `forFeature`
        // here is the wiring `apps/api/src/data-sync/data-sync.module.ts` documents as the
        // canonical pattern. Without it the service fails to instantiate, which is the
        // `DatabaseModule`-encapsulation trap this branch hit once already
        // (`packages/agent/src/database/__tests__/database-module-encapsulation.spec.ts`).
        TypeOrmModule.forFeature([CacheEntry]),
        // AW-22 Workspace backup — exposes WorkspaceBackupRunner and
        // WorkspaceBackupService through the remote-proxy controller so the
        // `workspace-backup` task and the `workspace-backup-sweeper` cron
        // (in packages/tasks) run the archive HERE, where the DataSource,
        // the storage backend and each Work's data-repo walk actually live.
        // The worker has no DataSource at all — every service it resolves is
        // an RPC proxy — so this is not a preference: the runner cannot be
        // constructed in worker scope. WorkspaceBackupRepository comes from
        // DatabaseModule above.
        AccountTransferModule,
    ],
    controllers: [TriggerInternalController],
    providers: [DistributedTaskLockService],
})
export class TriggerInternalModule {}
