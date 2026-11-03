/**
 * In-process events of the Ever Connect module (never forwarded by the public
 * webhook dispatcher; ids and states only).
 */

/** The connection changed: connected, approved, disconnected or revoked. */
export class EverConnectConnectionChangedEvent {
    static readonly EVENT_NAME = 'ever_connect.connection_changed';
    constructor(readonly status: 'disconnected' | 'pending_approval' | 'active' | 'revoked') {}
}

/** An installation-wide integration was turned on or off at Ever Platform. */
export class EverConnectIntegrationChangedEvent {
    static readonly EVENT_NAME = 'ever_connect.integration_changed';
    constructor(
        readonly integrationKey: string,
        readonly enabled: boolean,
    ) {}
}
