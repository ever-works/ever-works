import { BaseEvent } from './base';

export type WorksConfigSyncReason =
    | 'schedule_updated'
    | 'schedule_cancelled'
    | 'provider_changed'
    | 'pipeline_settings_changed';

export class WorksConfigSyncRequestedEvent extends BaseEvent {
    static EVENT_NAME = 'work.works_config.sync_requested';

    constructor(
        public readonly workId: string,
        public readonly userId: string,
        public readonly reason: WorksConfigSyncReason,
    ) {
        super();
    }
}
