import { Module } from '@nestjs/common';
import {
    WorkScheduleDispatcherService,
    WorkScheduleService,
} from '@ever-works/agent/services';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { createRemoteProxy } from '../remote-proxy';

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
    ],
    exports: [
        TriggerInternalApiClient,
        WorkScheduleDispatcherService,
        WorkScheduleService,
    ],
})
export class TriggerInternalModule {}
