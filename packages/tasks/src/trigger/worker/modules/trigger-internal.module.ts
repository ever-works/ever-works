import { Module } from '@nestjs/common';
import {
    DeployReadyPollerService,
    WorkScheduleDispatcherService,
    WorkScheduleService,
} from '@ever-works/agent/services';
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
    ],
    exports: [
        TriggerInternalApiClient,
        WorkScheduleDispatcherService,
        WorkScheduleService,
        DATA_SYNC_DISPATCHER_SERVICE,
        DeployReadyPollerService,
    ],
})
export class TriggerInternalModule {}
