import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WorksConfigSyncRequestedEvent } from '@src/events';
import { WorksConfigRepositorySyncService } from './works-config-repository-sync.service';

@Injectable()
export class WorksConfigSyncListener {
    constructor(private readonly syncService: WorksConfigRepositorySyncService) {}

    @OnEvent(WorksConfigSyncRequestedEvent.EVENT_NAME, { async: true })
    async handleSyncRequested(event: WorksConfigSyncRequestedEvent): Promise<void> {
        await this.syncService.syncDirectory({
            directoryId: event.directoryId,
            userId: event.userId,
            reason: event.reason,
        });
    }
}
