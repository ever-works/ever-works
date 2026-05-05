import { Work } from '@src/entities';
import { BaseEvent } from './base';

/**
 * Common payload shape carried by every deployment lifecycle event.
 * Activity-log listeners use this directly; new fields can be added
 * without breaking existing subscribers.
 */
export interface DeploymentEventPayload {
    /** The work being deployed. */
    readonly work: Work;
    /** User triggering the deployment (the work's owner most of the time). */
    readonly userId: string;
    /** Plugin id resolving the work's `deployProvider` (e.g. `'vercel'`, `'k8s'`). */
    readonly providerId: string;
    /** Human-readable provider name as shown in the UI. */
    readonly providerName: string;
}

/**
 * Emitted by `DeployService` immediately after a deployment workflow has
 * been dispatched against the work's website repo. The deployment is in
 * flight at this point — actual rollout success comes from a subsequent
 * `DeploymentCompletedEvent` / `DeploymentFailedEvent`.
 */
export class DeploymentDispatchedEvent extends BaseEvent {
    static EVENT_NAME = 'deployment.dispatched';

    constructor(public readonly payload: DeploymentEventPayload) {
        super();
    }
}

/**
 * Emitted by `DeploymentVerifierService` when the polled provider
 * confirms the rollout reached a `READY` state.
 */
export class DeploymentCompletedEvent extends BaseEvent {
    static EVENT_NAME = 'deployment.completed';

    constructor(
        public readonly payload: DeploymentEventPayload & {
            /** Public URL the provider returned (when available). */
            readonly url?: string;
        },
    ) {
        super();
    }
}

/**
 * Emitted by `DeploymentVerifierService` when the rollout reached a
 * terminal failure state (`ERROR`, `TIMEOUT`, `CANCELED`, polling error).
 * The `terminalState` distinguishes which one for activity-log entries.
 */
export class DeploymentFailedEvent extends BaseEvent {
    static EVENT_NAME = 'deployment.failed';

    constructor(
        public readonly payload: DeploymentEventPayload & {
            readonly terminalState: 'ERROR' | 'TIMEOUT' | 'CANCELED' | 'UNKNOWN';
            /** Optional error message captured from the provider. */
            readonly error?: string;
        },
    ) {
        super();
    }
}
