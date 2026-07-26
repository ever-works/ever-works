import { Module } from '@nestjs/common';
import {
    AnonymousUserCleanupService,
    DeployReadyPollerService,
    KnowledgeBaseReconcileService,
    WorkScheduleDispatcherService,
    WorkScheduleService,
} from '@ever-works/agent/services';
import { MissionTickService } from '@ever-works/agent/missions';
import { IdeaBuildExecutorService } from '@ever-works/agent/work-agent';
import { GoalEvaluationService } from '@ever-works/agent/goals';
import {
    AgentRunService,
    AgentRunSweeperService,
    AgentScheduleDispatcherService,
    RunDispatchGateService,
} from '@ever-works/agent/agents';
import {
    TaskChatService,
    TaskGateRunnerService,
    TaskRecurrenceDispatcherService,
    TaskRunDenormService,
    TasksService,
    TaskWorkspaceService,
} from '@ever-works/agent/tasks-domain';
import { AgentRepository, AgentRunRepository, WorkRepository } from '@ever-works/agent/database';
import { NotificationChannelFacadeService } from '@ever-works/agent/facades';
import { EventIngestService, EventSourcePullService } from '@ever-works/agent/ingest';
import { DigestService } from '@ever-works/agent/digest';
import { CreditLedgerService } from '@ever-works/agent/subscriptions';
import { FleetJobService } from '@ever-works/agent/fleet';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { createRemoteProxy } from '../remote-proxy';

/**
 * EW-628 G7 — `DataSyncDispatcherService` is provided here as a string
 * injection token so the data-repo-sync cron task can resolve it
 * without importing the API-side service class. The proxy forwards
 * `.dispatchDue()` calls over the trigger internal HTTP channel the
 * same way `WorkScheduleDispatcherService` already does for the
 * generation pipeline.
 */
export const DATA_SYNC_DISPATCHER_SERVICE = 'DataSyncDispatcherService';

@Module({
    providers: [
        TriggerInternalApiClient,
        {
            provide: WorkScheduleDispatcherService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkScheduleDispatcherService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: WorkScheduleService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkScheduleService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: DATA_SYNC_DISPATCHER_SERVICE,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'DataSyncDispatcherService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: DeployReadyPollerService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'DeployReadyPollerService'),
            inject: [TriggerInternalApiClient],
        },
        // Phase 3 PR J — mission-tick cron task resolves
        // MissionTickService via this proxy. The real service lives
        // in the API; the worker only needs the proxy to call
        // tickDue() over the internal HTTP channel each minute.
        {
            provide: MissionTickService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'MissionTickService'),
            inject: [TriggerInternalApiClient],
        },
        // PR-4 — idea-build-execute task resolves IdeaBuildExecutorService
        // via this proxy. The real service (with WorkProposalService +
        // repositories) lives in the API; the worker only needs the proxy
        // to call executeBuild() over the internal RPC channel.
        {
            provide: IdeaBuildExecutorService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'IdeaBuildExecutorService'),
            inject: [TriggerInternalApiClient],
        },
        // Goals & Metrics PR-8 — the goal-evaluate-dispatcher cron task
        // resolves GoalEvaluationService via this proxy. The real
        // service lives in the API (where the metrics-provider plugins
        // are loaded); the worker only calls evaluateDue() over the
        // internal HTTP channel each minute.
        {
            provide: GoalEvaluationService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'GoalEvaluationService'),
            inject: [TriggerInternalApiClient],
        },
        // Agents/Skills/Tasks PR #1017 — Phase 6. Per-Agent heartbeat
        // dispatcher + per-Agent repositories used by the
        // `agent-heartbeat-dispatcher` cron task and the
        // `agent-heartbeat` one-shot task.
        {
            provide: AgentScheduleDispatcherService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AgentScheduleDispatcherService'),
            inject: [TriggerInternalApiClient],
        },
        // Backs the `agent-run-sweeper` cron task.
        {
            provide: AgentRunSweeperService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AgentRunSweeperService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: AgentRunService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AgentRunService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: AgentRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AgentRepository'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: AgentRunRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AgentRunRepository'),
            inject: [TriggerInternalApiClient],
        },
        // Run orchestration (Wave 4 M2) — drain-on-terminal from the
        // agent-task-execute worker. The real gate (repository counts +
        // the @Global dispatcher token) lives in the API; the worker only
        // calls drainForWork over the internal RPC channel, same shape as
        // TaskWorkspaceService.
        {
            provide: RunDispatchGateService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'RunDispatchGateService'),
            inject: [TriggerInternalApiClient],
        },
        // Agents/Skills/Tasks PR #1017 — Phase 17. Recurring Task
        // dispatcher exposed for the task-recurrence-dispatcher cron.
        {
            provide: TaskRecurrenceDispatcherService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TaskRecurrenceDispatcherService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: TasksService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TasksService'),
            inject: [TriggerInternalApiClient],
        },
        // Wave 2 M3/M6 — worktree-per-Task isolation. The real service
        // (facades + repositories + the sandbox-workspace plugin) lives
        // in the API; agent-task-execute and the task-branch-gc cron
        // call provisionForRun/finalizeRun/sweepStaleBranches over the
        // internal RPC channel. Execution is API-side today (the run
        // itself is AgentRunService via this same proxy), so the
        // checkout and the dispatch share one filesystem.
        {
            provide: TaskWorkspaceService,
            useFactory: (apiClient) => createRemoteProxy(apiClient, 'TaskWorkspaceService'),
            inject: [TriggerInternalApiClient],
        },
        // Fleet job runtime (Desktop PRD M4) — the fleet-job-lease-sweeper
        // cron calls reclaimExpired() over the internal RPC channel. The
        // real service (repositories + the fleet entities) lives API-side,
        // same shape as TaskWorkspaceService.
        {
            provide: FleetJobService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'FleetJobService'),
            inject: [TriggerInternalApiClient],
        },
        // Wave 3 M2/M3 — quality gates. The acceptance-check runner lives
        // API-side (same filesystem as the provisioned workspace — see the
        // TaskWorkspaceService note above); agent-task-execute calls
        // runChecks over the internal RPC channel after the agent loop and
        // before the finalize/PR step.
        {
            provide: TaskGateRunnerService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TaskGateRunnerService'),
            inject: [TriggerInternalApiClient],
        },
        // Wave 3 M2 — dispatch-freeze. agent-task-execute loads the Task's
        // Work to resolve the acceptance-check set + policy right after the
        // run claim. The API already exposes 'WorkRepository' in its remote
        // map; this is just the worker-side proxy for it.
        {
            provide: WorkRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkRepository'),
            inject: [TriggerInternalApiClient],
        },
        // Kanban run cockpit (Wave 2) — latest-run denorm writes from the
        // agent-task-execute worker (after claim + terminal transitions).
        // The real service (TaskRepository graph) lives in the API; the
        // worker only calls recordQueued/recordStarted/recordTerminal over
        // the internal RPC channel, same shape as TaskWorkspaceService.
        {
            provide: TaskRunDenormService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TaskRunDenormService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: TaskChatService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TaskChatService'),
            inject: [TriggerInternalApiClient],
        },
        // Notifications v2 (EW-663) — the notification-channel-delivery
        // task calls `deliverToChannelOrThrow` on this proxy, which RPCs
        // to the live API where the channel plugins are loaded.
        {
            provide: NotificationChannelFacadeService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'NotificationChannelFacadeService'),
            inject: [TriggerInternalApiClient],
        },
        // EW-617 G2 / EW-637 - the nightly `anonymous-user-cleanup` cron
        // task resolved this service from a module that never provided it,
        // so every run since it shipped died with `Nest could not find
        // AnonymousUserCleanupService element`. Proxied to the API for the
        // same reason as NotificationChannelFacadeService above: the real
        // service needs the storage plugins, which are only loaded in the
        // API process (the task's own local ANON_CLEANUP_STORAGE_PLUGIN
        // factory imports an apps/api path that never resolves in worker
        // scope, so file GC silently no-opped).
        {
            provide: AnonymousUserCleanupService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AnonymousUserCleanupService'),
            inject: [TriggerInternalApiClient],
        },
        // EW-643 Phase 3 slice 4a - same defect for the daily
        // `kb-reconcile` cron task. The real service reads the KB upload
        // rows and lists the storage backend's `kb-originals/` prefix,
        // both of which live API-side.
        {
            provide: KnowledgeBaseReconcileService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'KnowledgeBaseReconcileService'),
            inject: [TriggerInternalApiClient],
        },
        // Event-ingest spine (Wave 6) — the event-ingest-tick cron task
        // calls `processBatch()` on this proxy, which RPCs to the live
        // API where the ingest repositories + Activity/Memory processors
        // are wired. Same shape as TaskWorkspaceService.
        {
            provide: EventIngestService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'EventIngestService'),
            inject: [TriggerInternalApiClient],
        },
        // Event-ingest pull path (Wave 8) — the same cron's PULL half:
        // `pullSources()` RPCs to the live API where the event-source
        // plugins, settings resolution and `ingest_cursors` rows are
        // wired. Same shape as EventIngestService above.
        {
            provide: EventSourcePullService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'EventSourcePullService'),
            inject: [TriggerInternalApiClient],
        },
        // Digest briefings (Wave 7) — the digest-dispatcher cron task
        // calls `dispatchDue(period)` on this proxy, which RPCs to the
        // live API where the digest composer's repositories + the
        // notifications producer are wired. Same shape as
        // TaskWorkspaceService.
        {
            provide: DigestService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'DigestService'),
            inject: [TriggerInternalApiClient],
        },
        // Credits ledger (pricing Wave 9 M1) — the credits-daily-grant
        // cron task calls `dispatchDailyGrants()` on this proxy, which
        // RPCs to the live API where the ledger/entitlement repositories
        // are wired. Same shape as EventIngestService above.
        {
            provide: CreditLedgerService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'CreditLedgerService'),
            inject: [TriggerInternalApiClient],
        },
    ],
    exports: [
        TriggerInternalApiClient,
        WorkScheduleDispatcherService,
        WorkScheduleService,
        DATA_SYNC_DISPATCHER_SERVICE,
        DeployReadyPollerService,
        MissionTickService,
        IdeaBuildExecutorService,
        GoalEvaluationService,
        AgentScheduleDispatcherService,
        AgentRunSweeperService,
        AgentRunService,
        AgentRepository,
        AgentRunRepository,
        RunDispatchGateService,
        TaskRecurrenceDispatcherService,
        TasksService,
        TaskChatService,
        TaskRunDenormService,
        TaskWorkspaceService,
        FleetJobService,
        TaskGateRunnerService,
        WorkRepository,
        NotificationChannelFacadeService,
        AnonymousUserCleanupService,
        KnowledgeBaseReconcileService,
        EventIngestService,
        EventSourcePullService,
        DigestService,
        CreditLedgerService,
    ],
})
export class TriggerInternalModule {}
