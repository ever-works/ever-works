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
} from '@ever-works/agent/agents';
import {
    TaskChatService,
    TaskRecurrenceDispatcherService,
    TasksService,
} from '@ever-works/agent/tasks-domain';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { NotificationChannelFacadeService } from '@ever-works/agent/facades';
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
        TaskRecurrenceDispatcherService,
        TasksService,
        TaskChatService,
        NotificationChannelFacadeService,
        AnonymousUserCleanupService,
        KnowledgeBaseReconcileService,
    ],
})
export class TriggerInternalModule {}
