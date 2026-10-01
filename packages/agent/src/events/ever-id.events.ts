import { BaseEvent } from './base';

/**
 * APW-12 (Ever ID) — internal events for the connected-identity lifecycle.
 *
 * Emitted on the in-process event bus after a connected identity is created
 * (sign-up confirmation, connect from Settings) or removed (disconnect). They
 * are additive: nothing in this repository subscribes to them today, and the
 * public webhook dispatcher must never forward them — the payload carries ids
 * only, never an issuer, a subject, an e-mail address or a token.
 */
export interface EverIdIdentityEventPayload {
    /** The `external_identities.id` of the identity. */
    readonly identityId: string;
    /** The Ever Works account it belongs (or belonged) to. */
    readonly userId: string;
    /** How the identity was connected (`linked`) — absent on `unlinked`. */
    readonly linkedVia?: 'sign-up' | 'settings' | 'provisioning';
    /** How many sessions the identity had opened that the disconnect ended (`unlinked`). */
    readonly sessionsEnded?: number;
}

/** A connected identity was created. */
export class EverIdIdentityLinkedEvent extends BaseEvent {
    static EVENT_NAME = 'ever_id.identity_linked';

    readonly identityId: string;
    readonly userId: string;
    readonly linkedVia?: 'sign-up' | 'settings' | 'provisioning';

    constructor(payload: EverIdIdentityEventPayload) {
        super();
        this.identityId = payload?.identityId ?? '';
        this.userId = payload?.userId ?? '';
        this.linkedVia = payload?.linkedVia;
    }
}

/** A connected identity was removed (the account itself is untouched, FR-30). */
export class EverIdIdentityUnlinkedEvent extends BaseEvent {
    static EVENT_NAME = 'ever_id.identity_unlinked';

    readonly identityId: string;
    readonly userId: string;
    readonly sessionsEnded: number;

    constructor(payload: EverIdIdentityEventPayload) {
        super();
        this.identityId = payload?.identityId ?? '';
        this.userId = payload?.userId ?? '';
        this.sessionsEnded = payload?.sessionsEnded ?? 0;
    }
}
