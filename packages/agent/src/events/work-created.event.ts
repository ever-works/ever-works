import { Work } from '@src/entities';
import { BaseEvent } from './base';

/**
 * Optional metadata describing a non-user actor that caused the Work to be
 * created. Today this is set only when the platform creates the underlying
 * GitHub repository on the user's behalf via `EverWorksGitProvider` (the
 * "Ever Works Git" storage choice — see EW-614). Downstream listeners
 * (activity log) record this so the audit trail distinguishes
 * "platform created this repo for the user" from "user created this repo
 * with their own OAuth token".
 */
export interface WorkCreatedPlatformActor {
    /** Stable kind tag: `'platform'` today. Extend if more actor kinds appear. */
    readonly actorKind: 'platform';
    /** Logical actor identifier — e.g. `'ever-works-cloud'` (the GitHub org). */
    readonly actor: string;
    /** `{owner}/{repo}` of the repo that was provisioned. */
    readonly repoFullName: string;
    /** Repo HTML URL — useful for activity-log UI links. */
    readonly htmlUrl: string;
}

export class WorkCreatedEvent extends BaseEvent {
    static EVENT_NAME = 'work.created';

    constructor(
        public readonly work: Work,
        public readonly platformActor?: WorkCreatedPlatformActor,
    ) {
        super();
    }
}
