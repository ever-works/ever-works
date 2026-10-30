import type { EverPlatformClient } from '@ever-co/connect-sdk';

/**
 * What the Ever ID handlers of a connected installation need from the Ever
 * Connect module, and nothing more: the connection's client, the state of the
 * `ever_id_login` integration with the sign-in client it stores, and a durable
 * queue for person-link reports.
 *
 * Every port has an unbound default ({@link UNBOUND_EVER_CONNECT_PROVIDERS}):
 * not connected, `ever_id_login` off, nothing stored. With those, the handlers
 * make no request and write nothing. The module that owns the connection binds
 * these tokens to its own services.
 */

/** The part of the SDK client the handlers call. */
export type EverPlatformCaller = Pick<EverPlatformClient, 'call'>;

export const EVER_CONNECT_PLATFORM = Symbol('EVER_CONNECT_PLATFORM');

export interface EverConnectPlatform {
    /**
     * The client of this installation's connection (it authenticates with the
     * installation's own token), or `null` when the installation is not connected.
     */
    client(): Promise<EverPlatformCaller | null>;
}

/** The sign-in client Ever Platform made for this installation. */
export interface EverIdLoginClient {
    readonly issuer: string;
    readonly clientId: string;
    /** Handed over once; stored sealed, never logged or returned by any route. */
    readonly clientSecret: string;
}

export const EVER_ID_LOGIN_INTEGRATION = Symbol('EVER_ID_LOGIN_INTEGRATION');

export interface EverIdLoginIntegration {
    /**
     * Whether `ever_id_login` is on for this installation: enabled in app.ever.co
     * and accepted by the installation's operator.
     */
    isEnabled(): Promise<boolean>;
    /** The stored sign-in client, or `null`. */
    readClient(): Promise<EverIdLoginClient | null>;
    /** Store the client (sealed); it replaces any previous one. */
    writeClient(client: EverIdLoginClient): Promise<void>;
    /** Forget the stored client. */
    clearClient(): Promise<void>;
}

/**
 * A link between a local account and an Ever ID, as reported to Ever Platform:
 * identifiers only, never an e-mail address or a name.
 */
export type PersonLinkReport =
    | {
          /** This report (its idempotency key): a later report of the same link is a new one. */
          readonly id: string;
          readonly op: 'link';
          /** The local account id (`product_user_ref`). */
          readonly userRef: string;
          readonly issuer: string;
          readonly subject: string;
          readonly linkMethod: 'explicit' | 'confirmed';
          /** The account's tenant (`product_tenant_id`), when it has one. */
          readonly tenantId?: string;
      }
    | {
          readonly id: string;
          readonly op: 'unlink';
          readonly userRef: string;
      };

export const EVER_CONNECT_REPORT_QUEUE = Symbol('EVER_CONNECT_REPORT_QUEUE');

export interface EverConnectReportQueue {
    /**
     * Keep a report until it is delivered: the queue's sender hands it to
     * `PersonLinkReporter.send` and retries on `retry`.
     */
    enqueue(report: PersonLinkReport): Promise<void>;
}

/** A port used before the module that owns it was bound. */
export class EverConnectNotBoundError extends Error {
    readonly name = 'EverConnectNotBoundError';
    constructor(port: string) {
        super(`${port} is not bound: the Ever Connect module provides it`);
    }
}

class UnboundEverConnectPlatform implements EverConnectPlatform {
    async client(): Promise<null> {
        return null;
    }
}

class UnboundEverIdLoginIntegration implements EverIdLoginIntegration {
    async isEnabled(): Promise<boolean> {
        return false;
    }
    async readClient(): Promise<null> {
        return null;
    }
    async writeClient(): Promise<void> {
        throw new EverConnectNotBoundError('EVER_ID_LOGIN_INTEGRATION');
    }
    async clearClient(): Promise<void> {
        // Nothing is stored.
    }
}

class UnboundEverConnectReportQueue implements EverConnectReportQueue {
    async enqueue(): Promise<void> {
        throw new EverConnectNotBoundError('EVER_CONNECT_REPORT_QUEUE');
    }
}

/** The defaults: not connected, `ever_id_login` off, nothing stored or queued. */
export const UNBOUND_EVER_CONNECT_PROVIDERS = [
    { provide: EVER_CONNECT_PLATFORM, useClass: UnboundEverConnectPlatform },
    { provide: EVER_ID_LOGIN_INTEGRATION, useClass: UnboundEverIdLoginIntegration },
    { provide: EVER_CONNECT_REPORT_QUEUE, useClass: UnboundEverConnectReportQueue },
];
