import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EVER_ID_LIMITS, EVER_ID_SCOPES } from '@ever-works/contracts';
import { IdentityTokenRejectedError, type VerifiedIdTokenClaims } from '@ever-works/plugin';
import { ExternalIdentityRepository, UserRepository } from '@ever-works/agent/database';
import {
    IdentityProviderFacadeService,
    IdentityProviderUnavailableError,
} from '@ever-works/agent/facades';
import { config } from '../../config/constants';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';
import type { AuthenticatedUser, TokenResponse } from '../types/auth.types';
import { EverIdActivityService, type EverIdRequestContext } from './ever-id-activity.service';
import { everIdError } from './ever-id-errors';
import { EverIdLinkingService, type EverIdSignInOutcome } from './ever-id-linking.service';
import { EverIdReplayService } from './ever-id-replay.service';
import { EverIdSealError, EverIdSealService } from './ever-id-seal.service';
import { EverIdSessionService, type EverIdCurrentSession } from './ever-id-session.service';
import { EVER_ID_TELEMETRY_EVENTS, EverIdTelemetryService } from './ever-id-telemetry.service';

/** The sealed browser transaction (plan §3.4, kind `txn`). */
export interface EverIdTransaction {
    state: string;
    nonce: string;
    codeVerifier: string;
    intent: 'sign-in' | 'connect';
    /** Connect only: the account and session that started it. */
    userId?: string;
    sessionId?: string;
    returnTo: string | null;
}

/** The path the provider returns the browser to, on the web host (FR-10). */
export const EVER_ID_CALLBACK_PATH = '/api/auth/ever-id/callback';

/** Where the provider returns the browser after "Also sign out of Ever ID" (FR-36). */
export const EVER_ID_LOGOUT_RETURN_PATH = '/api/auth/ever-id/logout-return';

/** Where a connect returns to: the security settings page that started it. */
const CONNECT_RETURN_TO = '/settings/security';

/** A device-exchange token may live at most this long; FR-40 bounds its age, not its life. */
const EXCHANGE_TOKEN_MAX_LIFETIME_SECONDS = 86_400;

/**
 * Normalise a return path (FR-10, ACC-12-12): a same-site relative path that
 * starts with `/` but not `//` (nor `/\`) and fits 2,048 characters. Anything
 * else — an absolute URL, another site, a protocol-relative path — falls back to
 * `null`, which the web reads as "the dashboard".
 */
export function safeReturnTo(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 2_048) return null;
    if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\'))
        return null;
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
    return trimmed;
}

/**
 * APW-12 (Ever ID) — the browser sign-in, connect, terminal exchange and
 * sign-out flows around the identity provider facade (plan §2.2, §2.3, §5.1).
 *
 * Every flow here first passes the API kill switch: the plugin must be enabled
 * by an administrator (else `404 everIdDisabled`, with no request to the
 * provider at all) and not marked unavailable (else `503 providerUnavailable`).
 */
@Injectable()
export class EverIdSignInService {
    private readonly logger = new Logger(EverIdSignInService.name);

    constructor(
        private readonly facade: IdentityProviderFacadeService,
        private readonly seal: EverIdSealService,
        private readonly replay: EverIdReplayService,
        private readonly sessions: EverIdSessionService,
        private readonly linking: EverIdLinkingService,
        private readonly identities: ExternalIdentityRepository,
        private readonly users: UserRepository,
        private readonly activity: EverIdActivityService,
        private readonly telemetry: EverIdTelemetryService,
        @Inject(AUTH_PROVIDER) private readonly authProvider: AuthProvider,
    ) {}

    /** The one redirect address per deployment, from configuration — never from the request (FR-10). */
    redirectUri(): string {
        return `${config.webAppUrl().replace(/\/+$/, '')}${EVER_ID_CALLBACK_PATH}`;
    }

    /** `POST /authorize` — start a browser sign-in (FR-8..FR-10). */
    async startSignIn(
        returnTo: unknown,
    ): Promise<{ authorizationUrl: string; transaction: string }> {
        await this.requireEnabled();
        const request = await this.provider(() =>
            this.facade.buildAuthorizationRequest({ redirectUri: this.redirectUri() }),
        );
        const txn: EverIdTransaction = {
            state: request.state,
            nonce: request.nonce,
            codeVerifier: request.codeVerifier,
            intent: 'sign-in',
            returnTo: safeReturnTo(returnTo),
        };
        let transaction: string;
        try {
            transaction = this.seal.seal<EverIdTransaction>('txn', txn);
        } catch (error) {
            // A return path too long to fit the cookie falls back to the
            // dashboard (FR-10) rather than failing the sign-in.
            if (!(error instanceof EverIdSealError)) throw error;
            transaction = this.seal.seal<EverIdTransaction>('txn', { ...txn, returnTo: null });
        }
        this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.SIGN_IN_STARTED, { intent: 'sign-in' });
        return { authorizationUrl: request.url, transaction };
    }

    /**
     * `POST /connect/authorize` — start connecting from Settings (FR-25): the
     * session must be younger than 12 hours, and the provider is asked for a
     * fresh sign-in (`prompt=login`, `max_age=300`).
     */
    async startConnect(
        user: AuthenticatedUser,
        session: EverIdCurrentSession | null,
    ): Promise<{ authorizationUrl: string; transaction: string }> {
        await this.requireEnabled();
        if (!session || session.userId !== user.userId) throw everIdError('sessionRequired');
        if (isOlderThan(session.createdAt, EVER_ID_LIMITS.connectMaxSessionAgeSeconds)) {
            throw everIdError('reauthRequired');
        }
        const publicConfig = await this.provider(() => this.facade.getPublicConfig());
        if (await this.identities.findByUserAndIssuer(user.userId, publicConfig.issuer)) {
            throw everIdError('userHasIssuer');
        }
        const request = await this.provider(() =>
            this.facade.buildAuthorizationRequest({
                redirectUri: this.redirectUri(),
                prompt: 'login',
                maxAgeSeconds: EVER_ID_LIMITS.connectMaxAuthAgeSeconds,
            }),
        );
        const transaction = this.seal.seal<EverIdTransaction>('txn', {
            state: request.state,
            nonce: request.nonce,
            codeVerifier: request.codeVerifier,
            intent: 'connect',
            userId: user.userId,
            sessionId: session.id,
            returnTo: CONNECT_RETURN_TO,
        });
        this.telemetry.emit(
            EVER_ID_TELEMETRY_EVENTS.SIGN_IN_STARTED,
            { intent: 'connect' },
            user.userId,
        );
        return { authorizationUrl: request.url, transaction };
    }

    /**
     * `POST /callback` — finish a sign-in or a connect (FR-11..FR-25). The
     * transaction is unsealed, its `state` compared in constant time and consumed
     * once (FR-19, S17, S21), the code exchanged and the ID token verified by the
     * plugin, and the linking rules decide the outcome.
     */
    async completeCallback(
        body: { code: string; state: string; iss?: string; transaction: string },
        headers: Headers,
        ctx: EverIdRequestContext,
    ): Promise<EverIdSignInOutcome> {
        const startedAt = Date.now();
        await this.requireEnabled();

        let txn: EverIdTransaction;
        try {
            txn = this.seal.unseal<EverIdTransaction>('txn', body.transaction);
        } catch (error) {
            if (error instanceof EverIdSealError) throw everIdError('transactionInvalid');
            throw error;
        }
        if (!constantTimeEquals(txn.state, body.state)) throw everIdError('transactionInvalid');
        if (
            !(await this.replay.consumeOnce('txn', txn.state, EVER_ID_LIMITS.transactionTtlSeconds))
        ) {
            throw everIdError('transactionInvalid');
        }

        let session: EverIdCurrentSession | null = null;
        if (txn.intent === 'connect') {
            session = await this.sessions.currentSession(headers);
            if (!session || session.userId !== txn.userId) throw everIdError('sessionRequired');
            if (isOlderThan(session.createdAt, EVER_ID_LIMITS.connectMaxSessionAgeSeconds)) {
                throw everIdError('reauthRequired');
            }
        }

        let claims: VerifiedIdTokenClaims;
        try {
            claims = await this.facade.exchangeAuthorizationCode({
                code: body.code,
                redirectUri: this.redirectUri(),
                codeVerifier: txn.codeVerifier,
                expectedNonce: txn.nonce,
                receivedIssuer: body.iss || undefined,
                maxAuthAgeSeconds:
                    txn.intent === 'connect' ? EVER_ID_LIMITS.connectMaxAuthAgeSeconds : undefined,
            });
        } catch (error) {
            throw this.mapTokenError(error, txn.intent === 'connect');
        }

        const outcome =
            txn.intent === 'connect' && session
                ? await this.linking.resolveConnect(claims, session)
                : await this.linking.resolveSignIn(claims, txn.returnTo, ctx);
        this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.SIGN_IN_COMPLETED, {
            outcome: outcome.outcome,
            durationMs: Date.now() - startedAt,
        });
        return outcome;
    }

    /**
     * `POST /session` — exchange a terminal client's Ever ID access token for an
     * Ever Works session (FR-39, FR-40). The token must carry the exchange scope
     * and the API audience, name a configured local client as its authorised
     * party, be at most 300 s old and carry an unused `jti`; the pair must already
     * be connected (S23). Terminal clients never create accounts.
     */
    async exchangeDeviceToken(
        token: string | null,
        ctx: EverIdRequestContext,
    ): Promise<TokenResponse> {
        await this.requireEnabled();
        if (!token) throw everIdError('transactionInvalid', HttpStatus.UNAUTHORIZED);
        const publicConfig = await this.provider(() => this.facade.getPublicConfig());
        const localClients = publicConfig.localClients ?? [];

        let claims: Awaited<ReturnType<IdentityProviderFacadeService['verifyAccessToken']>>;
        try {
            claims = await this.facade.verifyAccessToken(token, {
                requiredScopes: [EVER_ID_SCOPES.SESSION_EXCHANGE],
                maxLifetimeSeconds: EXCHANGE_TOKEN_MAX_LIFETIME_SECONDS,
                maxAgeSeconds: EVER_ID_LIMITS.exchangeTokenMaxAgeSeconds,
                allowedAuthorizedParties: localClients.map((client) => client.clientId),
            });
        } catch (error) {
            this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.DEVICE_EXCHANGED, { result: 'rejected' });
            throw this.mapTokenError(error, false);
        }
        if (!claims.jti) throw everIdError('transactionInvalid', HttpStatus.UNAUTHORIZED);
        if (
            !(await this.replay.consumeOnce(
                'session-jti',
                `${claims.issuer}|${claims.jti}`,
                EVER_ID_LIMITS.replayWindowSeconds,
            ))
        ) {
            throw everIdError('transactionInvalid', HttpStatus.UNAUTHORIZED);
        }

        const identity = await this.identities.findByIssuerSubject(claims.issuer, claims.subject);
        if (!identity) {
            this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.DEVICE_EXCHANGED, {
                result: 'notConnected',
            });
            throw everIdError('notConnected');
        }
        const user = await this.users.findById(identity.userId);
        if (!user || !user.isActive) {
            if (user) this.activity.signInRefused('accountDisabled', ctx, user.id);
            throw everIdError('accountDisabled');
        }

        const clientKind =
            localClients.find((client) => client.clientId === claims.authorizedParty)?.kind ??
            'unknown';
        const session = await this.authProvider.issueSession(
            user.id,
            { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
            { externalIdentityId: identity.id, externalSid: null },
        );
        await this.linking.recordSignIn(identity.id, user.id);
        const displayName = await this.linking.displayName();
        this.activity.signedInFromTerminal(user.id, identity.id, clientKind, displayName, ctx);
        this.telemetry.emit(
            EVER_ID_TELEMETRY_EVENTS.DEVICE_EXCHANGED,
            { clientKind, result: 'ok' },
            user.id,
        );
        return session;
    }

    /** `GET /client-config` — what a terminal client needs to start a device sign-in (FR-39). */
    async clientConfig(): Promise<{
        issuer: string;
        localClients: Array<{ kind: 'cli' | 'node'; clientId: string }>;
        scopes: string[];
    }> {
        await this.requireEnabled();
        const publicConfig = await this.provider(() => this.facade.getPublicConfig());
        return {
            issuer: publicConfig.issuer,
            localClients: (publicConfig.localClients ?? []).map((client) => ({
                kind: client.kind,
                clientId: client.clientId,
            })),
            scopes: ['openid', 'email', EVER_ID_SCOPES.SESSION_EXCHANGE],
        };
    }

    /**
     * `GET /logout-url` — the provider's sign-out address for the current
     * session (FR-36), only when Ever ID opened it and Ever ID is on. The `state`
     * is returned so the web can check it when the browser comes back.
     */
    async logoutUrl(session: EverIdCurrentSession | null): Promise<{ url: string; state: string }> {
        if (!session?.externalIdentityId) throw notAnEverIdSession();
        await this.requireEnabled();
        const state = randomBytes(EVER_ID_LIMITS.stateBytes).toString('base64url');
        const url = await this.provider(() =>
            this.facade.buildEndSessionUrl({
                postLogoutRedirectUri: `${config.webAppUrl().replace(/\/+$/, '')}${EVER_ID_LOGOUT_RETURN_PATH}`,
                state,
            }),
        );
        if (!url) throw notAnEverIdSession();
        return { url, state };
    }

    // ------------------------------------------------------------------
    // Kill switch and error mapping
    // ------------------------------------------------------------------

    /** FR-5: the sign-in family answers `404 everIdDisabled` unless an administrator enabled Ever ID. */
    async requireEnabled(): Promise<void> {
        const state = await this.facade.getState();
        if (!state.registered || !state.enabled) throw everIdError('everIdDisabled');
        if (state.unavailableSince) throw everIdError('providerUnavailable');
    }

    /** Run a provider call, mapping "not configured / unavailable" onto plan §5.2. */
    private async provider<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            throw this.mapProviderError(error);
        }
    }

    private mapProviderError(error: unknown): HttpException {
        if (error instanceof HttpException) return error;
        if (error instanceof IdentityProviderUnavailableError) {
            if (error.reason === 'unavailable' || error.reason === 'loadFailed') {
                this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.PROVIDER_UNAVAILABLE, {
                    stage: 'discovery',
                });
                return everIdError('providerUnavailable');
            }
            return everIdError('everIdDisabled');
        }
        // The plugin's own "cannot start" errors carry a closed `reason` (never text
        // from the provider): an unconfigured integration is "not available here";
        // anything else is the provider not answering properly.
        const reason = (error as { reason?: unknown })?.reason;
        if (reason === 'notConfigured') return everIdError('everIdDisabled');
        this.logger.warn(
            `Ever ID provider call failed (${typeof reason === 'string' ? reason : 'unknown'})`,
        );
        this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.PROVIDER_UNAVAILABLE, { stage: 'discovery' });
        return everIdError('providerUnavailable');
    }

    /** A refused token: `401 transactionInvalid`, the closed reason logged server-side only (plan §5.2). */
    private mapTokenError(error: unknown, connect: boolean): HttpException {
        if (error instanceof IdentityTokenRejectedError) {
            if (error.code === 'providerUnavailable') {
                this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.PROVIDER_UNAVAILABLE, {
                    stage: 'token',
                });
                return everIdError('providerUnavailable');
            }
            if (connect && error.code === 'tooOld') return everIdError('reauthRequired');
            this.logger.warn(`Ever ID token refused: ${error.code}`);
            return everIdError('transactionInvalid', HttpStatus.UNAUTHORIZED);
        }
        return this.mapProviderError(error);
    }
}

function notAnEverIdSession(): HttpException {
    return new HttpException(
        {
            status: 'error',
            code: 'not_found',
            message: 'The current session was not opened with Ever ID.',
        },
        HttpStatus.NOT_FOUND,
    );
}

function isOlderThan(createdAt: Date, seconds: number): boolean {
    const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
    return !Number.isFinite(created) || Date.now() - created > seconds * 1000;
}

/** FR-9: compare `state` in constant time (no early exit on the first differing byte). */
function constantTimeEquals(expected: string, received: unknown): boolean {
    if (typeof received !== 'string') return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    if (a.length !== b.length) {
        // Still spend a comparison so length alone is not a fast path.
        timingSafeEqual(a, a);
        return false;
    }
    return timingSafeEqual(a, b);
}
