import { Module } from '@nestjs/common';
import {
    AnonymousUserCleanupService,
    DeployReadyPollerService,
    KnowledgeBaseReconcileService,
    MemoryConsolidationScheduleService,
    WorkScheduleDispatcherService,
    WorkScheduleService,
} from '@ever-works/agent/services';
import { MissionTickService } from '@ever-works/agent/missions';
import { IdeaBuildExecutorService } from '@ever-works/agent/work-agent';
import { GoalEvaluationService, GoalOrchestratorService } from '@ever-works/agent/goals';
import {
    AgentEscalationService,
    AgentRunService,
    AgentRunSweeperService,
    AgentScheduleDispatcherService,
    RunDispatchGateService,
    TerminalTranscriptService,
} from '@ever-works/agent/agents';
import {
    TaskChatService,
    TaskGateJudgeService,
    TaskGateRunnerService,
    TaskPrStatusService,
    TaskRecurrenceDispatcherService,
    TaskReviewRejectionService,
    TaskRunDenormService,
    TasksService,
    TaskWorkspaceService,
} from '@ever-works/agent/tasks-domain';
import { AgentRepository, AgentRunRepository, WorkRepository } from '@ever-works/agent/database';
import { NotificationChannelFacadeService } from '@ever-works/agent/facades';
import { EventIngestService, EventSourcePullService } from '@ever-works/agent/ingest';
import { DigestService } from '@ever-works/agent/digest';
import { CreditLedgerService, CreditsSweepService } from '@ever-works/agent/subscriptions';
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
        // Autonomy layer — the goal-advance-dispatcher cron resolves
        // GoalOrchestratorService via this proxy. The real service lives in
        // the API, where the Tasks runtime and the dispatch gate are bound;
        // the worker only calls advanceDue() over the internal HTTP channel.
        {
            provide: GoalOrchestratorService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'GoalOrchestratorService'),
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
        // Judgment layer G3 - `agent-task-execute` files an escalation
        // here when the gate is exhausted (or the budget stopped the
        // iterate loop).
        {
            provide: AgentEscalationService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AgentEscalationService'),
            inject: [TriggerInternalApiClient],
        },
        // Orchestration M9 - `agent-task-execute` persists the machine
        // gate feedback here so a LATER resume can replay it.
        {
            provide: TaskReviewRejectionService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TaskReviewRejectionService'),
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
        // Judgment layer G2 — the acceptance-criteria judge. Must run
        // API-side for the same reason the gate runner does, plus one of
        // its own: it calls `AiFacadeService`, and the AI provider plugins
        // (and the budget guard + usage ledger behind them) are only
        // loaded in the API process. agent-task-execute calls `judge`
        // over the internal RPC channel after a GREEN gate.
        {
            provide: TaskGateJudgeService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TaskGateJudgeService'),
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
        // Kanban run cockpit (plan 04 M5/M7) — the task-pr-status-sync
        // cron calls syncDuePrStatuses() over the internal RPC channel.
        // The real service needs the git facade (provider plugins are
        // only loaded in the API process), same shape as
        // TaskWorkspaceService.
        {
            provide: TaskPrStatusService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TaskPrStatusService'),
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
        // Billing spec §3.2 — the credits-daily-grant cron task calls
        // `runDailySweep()` on this proxy (expiries → daily free → plan
        // allowance grants), which RPCs to the live API. Same shape as
        // CreditLedgerService above.
        {
            provide: CreditsSweepService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'CreditsSweepService'),
            inject: [TriggerInternalApiClient],
        },
        // Memory consolidation cadence (memory upgrades M9) — the
        // memory-consolidation-tick cron calls `dispatchDue()` on this
        // proxy, which RPCs to the live API where the org/tenant
        // repositories, the AI facade and the notification producer are
        // wired. Same shape as DigestService above.
        {
            provide: MemoryConsolidationScheduleService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'MemoryConsolidationScheduleService'),
            inject: [TriggerInternalApiClient],
        },
        // Terminal transcripts (streaming-terminal M9 / founder decision
        // D1) — the terminal-transcript-gc cron calls `sweepExpired()` on
        // this proxy, which RPCs to the live API where the chunk
        // repository and the plan-entitlement lever are wired. Same shape
        // as CreditLedgerService above.
        {
            provide: TerminalTranscriptService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'TerminalTranscriptService'),
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
        GoalOrchestratorService,
        AgentScheduleDispatcherService,
        AgentRunSweeperService,
        AgentRunService,
        AgentEscalationService,
        TaskReviewRejectionService,
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
        TaskGateJudgeService,
        WorkRepository,
        NotificationChannelFacadeService,
        AnonymousUserCleanupService,
        KnowledgeBaseReconcileService,
        EventIngestService,
        EventSourcePullService,
        DigestService,
        CreditLedgerService,
        CreditsSweepService,
        MemoryConsolidationScheduleService,
        TerminalTranscriptService,
    ],
})
export class TriggerInternalModule {}
