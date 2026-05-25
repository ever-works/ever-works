import { Module } from '@nestjs/common';
import {
    DeployReadyPollerService,
    WorkScheduleDispatcherService,
    WorkScheduleService,
} from '@ever-works/agent/services';
import { MissionTickService } from '@ever-works/agent/missions';
import { AgentScheduleDispatcherService } from '@ever-works/agent/agents';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
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
    ],
    exports: [
        TriggerInternalApiClient,
        WorkScheduleDispatcherService,
        WorkScheduleService,
        DATA_SYNC_DISPATCHER_SERVICE,
        DeployReadyPollerService,
        MissionTickService,
        AgentScheduleDispatcherService,
        AgentRepository,
        AgentRunRepository,
    ],
})
export class TriggerInternalModule {}
