import { Module } from '@nestjs/common';
import { TriggerInternalApiClient } from './trigger-internal-api.client';
import { RemoteDirectoryScheduleService } from './remote-directory-schedule.service';

@Module({
    providers: [TriggerInternalApiClient, RemoteDirectoryScheduleService],
    exports: [TriggerInternalApiClient, RemoteDirectoryScheduleService],
})
export class TriggerInternalModule {}
