import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { config } from '../../config/constants';
import { EVER_ID_CALLBACK_PATH } from '../../auth/services/ever-id-sign-in.service';
import { EverConnectIntegrationChangedEvent } from '../ever-connect.events';
import {
    EVER_CONNECT_PLATFORM,
    EVER_ID_LOGIN_INTEGRATION,
    type EverConnectPlatform,
    type EverIdLoginIntegration,
    type EverPlatformCaller,
} from './ever-connect-identity.ports';
import { EverIdClientSettings } from './ever-id-client.settings';
import { PersonLinkReporter } from './person-link.reporter';
import { describeFailure, platformFailure } from './platform-answer';

/**
 * The web route that hands Ever ID's back-channel sign-out notices to the API
 * (`apps/web/src/app/api/auth/ever-id/backchannel-logout/route.ts`): on the web
 * host, like the sign-in return address, because Ever Platform makes the client
 * only for two addresses on one origin.
 */
export const EVER_ID_WEB_BACKCHANNEL_LOGOUT_PATH = '/api/auth/ever-id/backchannel-logout';

/** The integration key of Sign in with Ever ID. */
const EVER_ID_LOGIN_KEY = 'ever_id_login';

/** The first read of a pending client, then twice as long each time up to 5 minutes. */
export const CLIENT_READ_FIRST_MS = 5_000;
export const CLIENT_READ_MAX_MS = 5 * 60_000;

/**
 * Where this installation's Ever ID client stands, as far as this process knows.
 *
 * - `off`: `ever_id_login` is off, or the installation is not connected.
 * - `requesting`: asking for the client failed for a reason worth retrying.
 * - `pending`: Ever Platform is making the client; it is read again shortly.
 * - `ready`: the client is stored and offered to the sign-in plugin.
 * - `failed`: Ever Platform could not make it, or refused the addresses. It is
 *   asked for again the next time `ever_id_login` is turned on.
 * - `revoked`: Ever Platform ended the client; the stored copy was removed.
 * - `secret_lost`: the client is ready but its secret, handed over only once,
 *   was not stored here. Turning Sign in with Ever ID off and on again in
 *   app.ever.co makes Ever Platform issue a new secret.
 */
export type EverIdLoginClientStatus =
    | 'off'
    | 'requesting'
    | 'pending'
    | 'ready'
    | 'failed'
    | 'revoked'
    | 'secret_lost';

/**
 * Sign in with Ever ID for a connected installation: asks Ever Platform for the
 * installation's own sign-in client (`POST /v1/instances/me/oidc-client`, with
 * the sign-in return and back-channel logout addresses), reads it until it is
 * ready (`GET`, every 5 seconds at first, up to every 5 minutes) and stores the
 * client, whose secret comes in the first ready answer only.
 *
 * The Ever Connect module calls {@link start} when `ever_id_login` is turned on
 * (and at boot while it is on) and {@link end} when it is turned off, revoked,
 * or the installation disconnects. Nothing here runs before that.
 */
@Injectable()
export class EverIdLoginHandler implements OnModuleDestroy {
    private readonly logger = new Logger(EverIdLoginHandler.name);
    private status: EverIdLoginClientStatus = 'off';
    private timer: NodeJS.Timeout | null = null;
    private delayMs = CLIENT_READ_FIRST_MS;
    /** Raised by {@link end}: an answer that arrives for an ended run stores nothing. */
    private generation = 0;
    private inFlight: Promise<EverIdLoginClientStatus> | null = null;
    private requestKey: string | null = null;

    constructor(
        @Inject(EVER_CONNECT_PLATFORM) private readonly platform: EverConnectPlatform,
        @Inject(EVER_ID_LOGIN_INTEGRATION) private readonly integration: EverIdLoginIntegration,
        private readonly settings: EverIdClientSettings,
        private readonly reporter: PersonLinkReporter,
    ) {}

    onModuleDestroy(): void {
        this.cancelTimer();
    }

    /** `ever_id_login` turned on or off at Ever Platform (or with the connection). */
    @OnEvent(EverConnectIntegrationChangedEvent.EVENT_NAME, { async: true })
    async onIntegrationChanged(event: EverConnectIntegrationChangedEvent): Promise<void> {
        if (event.integrationKey !== EVER_ID_LOGIN_KEY) return;
        try {
            if (event.enabled) await this.start();
            else await this.end();
        } catch (error) {
            this.logger.warn(
                `Ever ID client not updated: ${error instanceof Error ? error.name : 'unknown'}`,
            );
        }
    }

    getStatus(): EverIdLoginClientStatus {
        return this.status;
    }

    /** The two addresses the client is made for: the web host's sign-in return and logout. */
    clientAddresses(): { redirect_uri: string; logout_uri: string } {
        const web = config.webAppUrl().replace(/\/+$/, '');
        return {
            redirect_uri: `${web}${EVER_ID_CALLBACK_PATH}`,
            logout_uri: `${web}${EVER_ID_WEB_BACKCHANNEL_LOGOUT_PATH}`,
        };
    }

    /**
     * Make sure the installation has its client: ask for it unless one is
     * stored, then read it. Resolves with the status after the first read.
     */
    start(): Promise<EverIdLoginClientStatus> {
        return this.single(() => this.requestAndRead());
    }

    /** Read the client's state now (a pending client is otherwise read on its schedule). */
    refresh(): Promise<EverIdLoginClientStatus> {
        return this.single(() => this.read(this.generation));
    }

    /**
     * `ever_id_login` ended (turned off, revoked, or the installation
     * disconnected): stop reading and forget the stored client. The local
     * accounts and their connected identities stay.
     */
    async end(): Promise<void> {
        this.generation += 1;
        this.cancelTimer();
        this.delayMs = CLIENT_READ_FIRST_MS;
        await this.integration.clearClient();
        this.settings.invalidate();
        this.status = 'off';
    }

    private async single(
        run: () => Promise<EverIdLoginClientStatus>,
    ): Promise<EverIdLoginClientStatus> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = run().finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private async connectedClient(): Promise<EverPlatformCaller | null> {
        if (!(await this.integration.isEnabled())) return null;
        return this.platform.client();
    }

    private async requestAndRead(): Promise<EverIdLoginClientStatus> {
        const generation = this.generation;
        this.cancelTimer();
        const client = await this.connectedClient();
        if (!client) return this.set('off');
        if (await this.integration.readClient()) return this.set('ready');

        const body = this.clientAddresses();
        // One key per request, kept while it is retried: a retry is answered once,
        // and a later request (after a revocation) is a new one.
        this.requestKey ??= `oidc-client-${randomUUID()}`;
        try {
            await client.call('instanceRequestOidcClient', {
                body,
                idempotencyKey: this.requestKey,
            });
            this.requestKey = null;
        } catch (error) {
            const failure = platformFailure(error);
            const retryable =
                failure.kind === 'transient' ||
                failure.kind === 'rate_limited' ||
                (failure.kind === 'problem' && failure.status >= 500);
            if (!retryable) this.requestKey = null;
            if (failure.kind === 'problem' && failure.status === 409) {
                // A client is pending or ready already: read it.
            } else if (failure.kind === 'problem' && failure.status === 403) {
                this.logger.log(`Ever ID client not requested: ${describeFailure(failure)}`);
                return this.set('off');
            } else if (
                (failure.kind === 'problem' && failure.status < 500) ||
                failure.kind === 'refused'
            ) {
                // The addresses or the product were refused: asking again changes nothing.
                this.logger.warn(`Ever ID client refused: ${describeFailure(failure)}`);
                return this.set('failed');
            } else {
                this.logger.warn(
                    `Ever ID client request will be retried: ${describeFailure(failure)}`,
                );
                this.schedule(
                    () => this.start(),
                    failure.kind === 'rate_limited' ? failure.retryAfterS * 1000 : undefined,
                );
                return this.set('requesting');
            }
        }
        if (generation !== this.generation) return this.status;
        this.delayMs = CLIENT_READ_FIRST_MS;
        return this.read(generation);
    }

    private async read(generation: number): Promise<EverIdLoginClientStatus> {
        this.cancelTimer();
        const client = await this.connectedClient();
        if (!client) return this.set('off');

        let answer: {
            status?: unknown;
            issuer?: unknown;
            client_id?: unknown;
            client_secret?: unknown;
        };
        try {
            answer = (await client.call('instanceGetOidcClient')) as typeof answer;
        } catch (error) {
            const failure = platformFailure(error);
            if (failure.kind === 'problem' && failure.status === 404) {
                // Nothing was asked for (or it was forgotten): ask again.
                this.schedule(() => this.start(), CLIENT_READ_FIRST_MS);
                return this.set('requesting');
            }
            if (failure.kind === 'problem' && failure.status === 403) {
                // `ever_id_login` ended or the installation was disconnected: Ever
                // Platform has revoked the client, so the stored copy is dead.
                if (generation === this.generation) {
                    await this.integration.clearClient();
                    this.settings.invalidate();
                }
                return this.set('off');
            }
            this.logger.warn(`Ever ID client read will be retried: ${describeFailure(failure)}`);
            this.schedule(
                () => this.refresh(),
                failure.kind === 'rate_limited' ? failure.retryAfterS * 1000 : undefined,
            );
            return this.status;
        }
        if (generation !== this.generation) return this.status;

        switch (answer.status) {
            case 'pending':
                this.schedule(() => this.refresh());
                return this.set('pending');
            case 'ready':
                return this.ready(answer);
            case 'revoked':
                await this.integration.clearClient();
                this.settings.invalidate();
                return this.set('revoked');
            case 'failed':
                this.logger.warn('Ever Platform could not make the Ever ID client');
                return this.set('failed');
            default:
                this.schedule(() => this.refresh());
                return this.status;
        }
    }

    private async ready(answer: {
        issuer?: unknown;
        client_id?: unknown;
        client_secret?: unknown;
    }): Promise<EverIdLoginClientStatus> {
        const issuer = nonEmpty(answer.issuer);
        const clientId = nonEmpty(answer.client_id);
        const clientSecret = nonEmpty(answer.client_secret);

        if (issuer && clientId && clientSecret) {
            try {
                await this.integration.writeClient({ issuer, clientId, clientSecret });
            } catch (error) {
                // The secret is not handed over again: say so, without the value.
                this.logger.error(
                    `The Ever ID client secret could not be stored (${
                        error instanceof Error ? error.name : 'unknown'
                    }); turn Sign in with Ever ID off and on again in app.ever.co`,
                );
                return this.set('secret_lost');
            }
            this.settings.invalidate();
            this.set('ready');
            // Links made before the client existed are reported once.
            this.reporter
                .reportExistingLinks(issuer)
                .catch((error) =>
                    this.logger.warn(
                        `Existing Ever ID links not reported: ${
                            error instanceof Error ? error.name : 'unknown'
                        }`,
                    ),
                );
            return this.status;
        }

        const stored = await this.integration.readClient();
        if (stored && clientId && stored.clientId === clientId) return this.set('ready');
        this.logger.warn(
            'The Ever ID client is ready but its secret was handed over before and is not stored here; turn Sign in with Ever ID off and on again in app.ever.co',
        );
        return this.set('secret_lost');
    }

    private set(status: EverIdLoginClientStatus): EverIdLoginClientStatus {
        this.status = status;
        return status;
    }

    private schedule(run: () => Promise<unknown>, afterMs?: number): void {
        this.cancelTimer();
        const delay = afterMs ?? this.delayMs;
        this.delayMs = Math.min(this.delayMs * 2, CLIENT_READ_MAX_MS);
        this.timer = setTimeout(() => {
            this.timer = null;
            run().catch((error) =>
                this.logger.warn(
                    `Ever ID client step failed: ${error instanceof Error ? error.name : 'unknown'}`,
                ),
            );
        }, delay);
        this.timer.unref?.();
    }

    private cancelTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
}

function nonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}
