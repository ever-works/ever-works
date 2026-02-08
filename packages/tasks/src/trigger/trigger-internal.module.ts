import { Module } from '@nestjs/common';
import {
    DirectoryScheduleDispatcherService,
    DirectoryScheduleService,
} from '@ever-works/agent/services';
import { TriggerInternalApiClient } from './trigger-internal-api.client';
import { createRemoteProxy } from './plugins/remote-proxy';

@Module({
    providers: [
        TriggerInternalApiClient,
        {
            provide: DirectoryScheduleDispatcherService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'DirectoryScheduleDispatcherService'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: DirectoryScheduleService,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'DirectoryScheduleService'),
            inject: [TriggerInternalApiClient],
        },
    ],
    exports: [
        TriggerInternalApiClient,
        DirectoryScheduleDispatcherService,
        DirectoryScheduleService,
    ],
})
export class TriggerInternalModule {}
