import { Module } from '@nestjs/common';
import { TriggerInternalApiClient } from './trigger-internal-api.client';
import { RemoteDirectoryScheduleService } from './remote-directory-schedule.service';
import { RemoteNotificationOperationsService } from './remote-notification-operations.service';

@Module({
    providers: [
        TriggerInternalApiClient,
        RemoteDirectoryScheduleService,
        RemoteNotificationOperationsService,
    ],
    exports: [
        TriggerInternalApiClient,
        RemoteDirectoryScheduleService,
        RemoteNotificationOperationsService,
    ],
})
export class TriggerInternalModule {}
