import { BaseEvent } from './base';
import type { WorksConfigSyncReason } from './works-config-sync-requested.event';

export class WorksConfigSyncFailedEvent extends BaseEvent {
    static EVENT_NAME = 'directory.works_config.sync_failed';

    constructor(
        public readonly directoryId: string,
        public readonly userId: string,
        public readonly reason: WorksConfigSyncReason,
        public readonly repository: string,
        public readonly errorMessage: string,
    ) {
        super();
    }
}
