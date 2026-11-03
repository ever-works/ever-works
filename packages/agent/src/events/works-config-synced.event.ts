import { BaseEvent } from './base';
import type { WorksConfigSyncReason } from './works-config-sync-requested.event';

/**
 * EW-612 — `.works/works.yml` was rewritten AND pushed to the data repo.
 *
 * Emitted only when the sync actually produced a commit; a sync that finds the
 * file already up to date is a no-op and stays silent, so re-saving the same
 * deploy provider cannot accumulate activity-log noise.
 *
 * The counterpart of `WorksConfigSyncFailedEvent`: both are consumed by the
 * API's activity-log listener so the work owner can audit what the platform
 * wrote to their data repo on their behalf, and why.
 */
export class WorksConfigSyncedEvent extends BaseEvent {
    static EVENT_NAME = 'work.works_config.synced';

    constructor(
        public readonly workId: string,
        public readonly userId: string,
        public readonly reason: WorksConfigSyncReason,
        /** `owner/repo` of the data repository that received the commit. */
        public readonly repository: string,
        /**
         * Deploy provider plugin id written into the file by this sync, when
         * the projection carried one (`null` otherwise). Provider-agnostic —
         * nothing here branches on the value.
         */
        public readonly deployProvider: string | null = null,
    ) {
        super();
    }
}
