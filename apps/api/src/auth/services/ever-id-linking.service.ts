import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import {
    EVER_ID_DEFAULT_DISPLAY_NAME,
    EVER_ID_LIMITS,
    EVER_ID_REGISTRATION_PROVIDER,
    type EverIdCallbackOutcome,
} from '@ever-works/contracts';
import type { VerifiedIdTokenClaims } from '@ever-works/plugin';
import {
    ExternalIdentityConflictError,
    ExternalIdentityRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { AuthAccount, User, type ExternalIdentity } from '@ever-works/agent/entities';
import { EverIdIdentityLinkedEvent, EverIdIdentityUnlinkedEvent } from '@ever-works/agent/events';
import { IdentityProviderFacadeService } from '@ever-works/agent/facades';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';
import { getBcryptCost } from '../providers/bcrypt-cost';
import type { TokenResponse } from '../types/auth.types';
import {
    TermsAcceptanceService,
    type TermsAcceptanceClaim,
} from '../../terms/terms-acceptance.service';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';
import { UserConfirmedEvent } from '../../events';
import { config } from '../../config/constants';
import { EverIdActivityService, type EverIdRequestContext } from './ever-id-activity.service';
import { EverIdClaimHintsService } from './ever-id-claims-hints';
import { everIdError } from './ever-id-errors';
import { EverIdReplayService } from './ever-id-replay.service';
import { EverIdSealError, EverIdSealService } from './ever-id-seal.service';
import { EverIdSessionService, type EverIdCurrentSession } from './ever-id-session.service';
import { EVER_ID_TELEMETRY_EVENTS, EverIdTelemetryService } from './ever-id-telemetry.service';

/** A pending account creation or account-exists hand-off, sealed under the `signUp` kind (plan §3.4). */
export interface EverIdSignUpPending {
    id: string;
    kind: 'signUp' | 'emailInUse';
    email: string;
    issuer?: string;
    subject?: string;
    name?: string | null;
    sid?: string | null;
    returnTo?: string | null;
}

/** A pending connection from Settings, sealed under the `connect` kind (plan §3.4). */
export interface EverIdConnectPending {
    id: string;
    issuer: string;
    subject: string;
    email: string;
    userId: string;
    sid: string | null;
}

/** One app that read the person's App Works with a delegated permission, as the card shows it. */
export interface ExternalIdentityDelegatedClientDto {
    clientId: string;
    displayName: string;
    lastSeenAt: string;
}

/** `ExternalIdentityDto` (plan §5.1): issuer and subject are never returned. */
export interface ExternalIdentityDto {
    id: string;
    displayName: string;
    email: string;
    linkedAt: string;
    linkedVia: string;
    lastLoginAt: string | null;
    delegatedClients: ExternalIdentityDelegatedClientDto[];
}

export interface ExternalIdentityListDto {
    items: ExternalIdentityDto[];
    canDisconnect: boolean;
    disconnectBlockedReason?: 'last_sign_in_method';
    manageUrl?: string;
}

/** A sign-in outcome plus the return path the web redirects to. */
export type EverIdSignInOutcome = EverIdCallbackOutcome & { returnTo?: string | null };

/** The sign-up confirmation answer: the existing token response plus the return path. */
export type EverIdSignUpResponse = TokenResponse & { returnTo: string | null };

/** Response body for a disconnect target that does not exist for this account. */
function identityNotFound(): HttpException {
    return new HttpException(
        { status: 'error', code: 'not_found', message: 'No such connected identity.' },
        HttpStatus.NOT_FOUND,
    );
}

/**
 * APW-12 (Ever ID) — the linking and account-creation rules (spec FR-20..FR-31,
 * plan §5.5, the decision tree of spec §5.3).
 *
 * | Case | Condition | Outcome |
 * |---|---|---|
 * | L1 | the pair is connected and the account active | session (S1) |
 * | L2 | unknown pair, verified e-mail no account uses, sign-up allowed | `confirmSignUp` → the S2 screen |
 * | L3 | unknown pair, an account already uses the e-mail | `emailInUse` (S3) — nothing created |
 * | L4 | unknown pair, e-mail missing or unverified | `422 emailNotVerified` (S11) |
 * | L5 | connect intent from Settings | `confirmConnect` → the S4 screen |
 * | L6 | disconnect | allowed only while another way to sign in remains (S14) |
 *
 * Hard rules: an e-mail address NEVER selects an account (FR-22) — the only
 * question asked of it is the boolean "does any account use it" (S3); a pair
 * belongs to at most one account and an account has at most one pair per issuer
 * (FR-21, decided by the table's unique constraints); no provider token is ever
 * stored (FR-31).
 */
@Injectable()
export class EverIdLinkingService {
    private readonly logger = new Logger(EverIdLinkingService.name);

    constructor(
        private readonly identities: ExternalIdentityRepository,
        private readonly users: UserRepository,
        private readonly facade: IdentityProviderFacadeService,
        private readonly seal: EverIdSealService,
        private readonly replay: EverIdReplayService,
        private readonly sessions: EverIdSessionService,
        private readonly activity: EverIdActivityService,
        private readonly telemetry: EverIdTelemetryService,
        private readonly claimHints: EverIdClaimHintsService,
        private readonly terms: TermsAcceptanceService,
        private readonly usernames: UsernameAllocatorService,
        private readonly events: EventEmitter2,
        @Inject(AUTH_PROVIDER) private readonly authProvider: AuthProvider,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    // ------------------------------------------------------------------
    // Sign-in (L1–L4)
    // ------------------------------------------------------------------

    async resolveSignIn(
        claims: VerifiedIdTokenClaims,
        returnTo: string | null,
        ctx: EverIdRequestContext,
    ): Promise<EverIdSignInOutcome> {
        const displayName = await this.displayName();
        const identity = await this.identities.findByIssuerSubject(claims.issuer, claims.subject);

        if (identity) {
            // L1 — the pair is connected.
            const user = await this.users.findById(identity.userId);
            if (!user) throw everIdError('transactionInvalid');
            if (!user.isActive) {
                this.activity.signInRefused('accountDisabled', ctx, user.id);
                throw everIdError('accountDisabled');
            }
            const hints = await this.claimHints.evaluate(user.id, claims.hints);
            if (hints.refused) {
                this.activity.signInRefused('companySignInRequired', ctx, user.id);
                throw new HttpException(
                    {
                        status: 'error',
                        code: 'company_sign_in_required',
                        message:
                            'This organization requires its company identity for Ever ID sign-in.',
                    },
                    HttpStatus.FORBIDDEN,
                );
            }
            if (hints.preselectedOrganizationId) {
                await this.claimHints.applyPreselection(user.id, hints.preselectedOrganizationId);
            }
            const token = await this.authProvider.issueSession(
                user.id,
                { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
                { externalIdentityId: identity.id, externalSid: claims.sid },
            );
            await this.recordSignIn(identity.id, user.id);
            this.activity.signedIn(user.id, identity.id, displayName, ctx);
            return {
                outcome: 'signedIn',
                access_token: token.access_token,
                user: token.user,
                returnTo,
            };
        }

        // L4 — no verified e-mail, nothing is created or connected (S11).
        if (!claims.emailVerified || !claims.email) {
            this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.SIGN_IN_COMPLETED, {
                outcome: 'emailNotVerified',
            });
            throw everIdError('emailNotVerified');
        }

        // L3 — the address belongs to an account: S3, never a link (FR-22, FR-24).
        if (await this.users.existsByEmailCaseInsensitive(claims.email)) {
            const pending = this.seal.seal<EverIdSignUpPending>('signUp', {
                id: randomUUID(),
                kind: 'emailInUse',
                email: claims.email,
            });
            return { outcome: 'emailInUse', email: claims.email, pending };
        }

        // L2 — an account may be created, after the S2 confirmation only (FR-23).
        const publicConfig = await this.facade.getPublicConfig();
        if (!publicConfig.signUpAllowed) throw everIdError('signUpNotAllowed');
        const pending = this.seal.seal<EverIdSignUpPending>('signUp', {
            id: randomUUID(),
            kind: 'signUp',
            issuer: claims.issuer,
            subject: claims.subject,
            email: claims.email,
            name: claims.name,
            sid: claims.sid,
            returnTo,
        });
        return {
            outcome: 'confirmSignUp',
            pending,
            identity: { email: claims.email, name: claims.name },
            returnTo,
        };
    }

    /**
     * FR-23's confirmation: create the account, connect the pair, record the terms
     * and open the session — in that explicit, compensatable order, because the
     * terms recorder writes through the auth library's adapter and cannot share a
     * transaction with the user insert (plan §5.1).
     */
    async confirmSignUp(
        pendingValue: string,
        acceptedTerms: TermsAcceptanceClaim[],
        ctx: EverIdRequestContext,
    ): Promise<EverIdSignUpResponse> {
        const pending = this.unsealOrInvalid<EverIdSignUpPending>('signUp', pendingValue);
        if (pending.kind !== 'signUp' || !pending.issuer || !pending.subject || !pending.email) {
            throw everIdError('transactionInvalid');
        }

        // Every currently required terms document must be accepted (FR-23).
        this.terms.assertClaimsArePublished(acceptedTerms);
        const required = this.terms.getRequiredDocuments();
        const accepted = new Set(acceptedTerms.map((claim) => claim.documentId));
        if (required.some((document) => !accepted.has(document.documentId))) {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'terms_required',
                    message: 'Accept every required terms document to create the account.',
                },
                HttpStatus.BAD_REQUEST,
            );
        }

        const publicConfig = await this.facade.getPublicConfig();
        if (!publicConfig.signUpAllowed) throw everIdError('signUpNotAllowed');

        // (1) single use (FR-23: the pending creation is single-use).
        if (
            !(await this.replay.consumeOnce(
                'pending',
                pending.id,
                EVER_ID_LIMITS.signUpPendingTtlSeconds,
            ))
        ) {
            throw everIdError('transactionInvalid');
        }

        // (2) pre-check the pair and the address, so a pair connected elsewhere — or an
        // address an account took meanwhile — fails before any account exists.
        if (await this.identities.findByIssuerSubject(pending.issuer, pending.subject)) {
            throw everIdError('subjectLinked');
        }
        if (await this.users.existsByEmailCaseInsensitive(pending.email)) {
            throw everIdError('emailInUse');
        }

        // (3) the account.
        const username = await this.usernames.allocateUsername(
            pending.name?.trim() || pending.email.split('@')[0],
        );
        const user = await this.users.create({
            username,
            email: pending.email,
            password: await bcrypt.hash(randomBytes(32).toString('hex'), getBcryptCost()),
            registrationProvider: EVER_ID_REGISTRATION_PROVIDER,
            // The provider verified the address (`email_verified`), which is the
            // only way into this branch.
            emailVerified: true,
            isActive: true,
            lastLoginAt: new Date(),
        });

        // (4) the connection — the unique constraint decides the S24 race. The loser
        // is compensated: the account it just created is removed again.
        let identity: ExternalIdentity;
        try {
            identity = await this.identities.insertLink({
                userId: user.id,
                issuer: pending.issuer,
                subject: pending.subject,
                emailAtLink: pending.email,
                emailVerifiedAtLink: true,
                linkedVia: 'sign-up',
            });
        } catch (error) {
            await this.dataSource
                .getRepository(User)
                .delete({ id: user.id })
                .catch(() => undefined);
            if (error instanceof ExternalIdentityConflictError) throw everIdError('subjectLinked');
            throw error;
        }

        // (5) terms, best-effort exactly as the register route does: the claims were
        // validated above, so a failure here is infrastructure and must not orphan
        // the account it just created.
        try {
            await this.terms.record(user.id, acceptedTerms, {
                method: 'ever-id-signup',
                ip: ctx.ipAddress,
                userAgent: ctx.userAgent,
            });
        } catch (error) {
            this.logger.error(
                `Failed to record terms acceptance for an Ever ID sign-up: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }

        // (6) the session, marked with the identity that opened it (FR-32).
        const token = await this.authProvider.issueSession(
            user.id,
            { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
            { externalIdentityId: identity.id, externalSid: pending.sid ?? null },
        );
        await this.identities.touchLogin(identity.id);

        const displayName = await this.displayName();
        this.activity.signedUp(user.id, identity.id, displayName, ctx);
        this.events.emit(
            EverIdIdentityLinkedEvent.EVENT_NAME,
            new EverIdIdentityLinkedEvent({
                identityId: identity.id,
                userId: user.id,
                linkedVia: 'sign-up',
            }),
        );
        // The same welcome the social sign-up path sends for a verified address.
        this.events.emit(
            UserConfirmedEvent.EVENT_NAME,
            new UserConfirmedEvent(user, `${config.webAppUrl()}/works/new`),
        );
        this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.SIGN_UP_CONFIRMED, {}, user.id);

        return { ...token, returnTo: pending.returnTo ?? null };
    }

    // ------------------------------------------------------------------
    // Connect (L5)
    // ------------------------------------------------------------------

    /**
     * The callback half of connecting from Settings: the fresh sign-in at the
     * provider is checked (by the plugin: `auth_time` within 300 s + skew), the
     * e-mail must be verified, and nothing is written yet — the person confirms
     * on the S4 screen first (FR-25).
     */
    async resolveConnect(
        claims: VerifiedIdTokenClaims,
        session: EverIdCurrentSession,
    ): Promise<EverIdSignInOutcome> {
        if (!claims.emailVerified || !claims.email) throw everIdError('emailNotVerified');
        const account = await this.users.findById(session.userId);
        if (!account || !account.isActive) throw everIdError('accountDisabled');

        const existing = await this.identities.findByIssuerSubject(claims.issuer, claims.subject);
        if (existing) {
            // Connected already — to another account (S12) or to this one (S13).
            throw everIdError(
                existing.userId === session.userId ? 'userHasIssuer' : 'subjectLinked',
            );
        }
        if (await this.identities.findByUserAndIssuer(session.userId, claims.issuer)) {
            throw everIdError('userHasIssuer');
        }

        const pending = this.seal.seal<EverIdConnectPending>('connect', {
            id: randomUUID(),
            issuer: claims.issuer,
            subject: claims.subject,
            email: claims.email,
            userId: session.userId,
            sid: claims.sid,
        });
        return {
            outcome: 'confirmConnect',
            pending,
            identity: { email: claims.email },
            accountEmail: account.email ?? '',
        };
    }

    /** S4's Connect: the connection is created, single use, within 300 s (FR-25, FR-26). */
    async confirmConnect(
        pendingValue: string,
        userId: string,
        ctx: EverIdRequestContext,
    ): Promise<ExternalIdentityDto> {
        const pending = this.unsealOrInvalid<EverIdConnectPending>('connect', pendingValue);
        if (pending.userId !== userId) throw everIdError('transactionInvalid');
        if (
            !(await this.replay.consumeOnce(
                'pending',
                pending.id,
                EVER_ID_LIMITS.connectPendingTtlSeconds,
            ))
        ) {
            throw everIdError('transactionInvalid');
        }
        const account = await this.users.findById(userId);
        if (!account || !account.isActive) throw everIdError('accountDisabled');

        let identity: ExternalIdentity;
        try {
            identity = await this.identities.insertLink({
                userId,
                issuer: pending.issuer,
                subject: pending.subject,
                emailAtLink: pending.email,
                emailVerifiedAtLink: true,
                linkedVia: 'settings',
                tenantId: account.tenantId ?? null,
            });
        } catch (error) {
            if (error instanceof ExternalIdentityConflictError) throw everIdError(error.reason);
            throw error;
        }

        const emailsDiffer =
            (account.email ?? '').trim().toLowerCase() !== pending.email.trim().toLowerCase();
        const displayName = await this.displayName();
        this.activity.connected(userId, identity.id, emailsDiffer, displayName, ctx);
        this.events.emit(
            EverIdIdentityLinkedEvent.EVENT_NAME,
            new EverIdIdentityLinkedEvent({
                identityId: identity.id,
                userId,
                linkedVia: 'settings',
            }),
        );
        this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.IDENTITY_LINKED, { emailsDiffer }, userId);
        const names = await this.delegatedClientNames();
        return this.toDto(identity, displayName, names);
    }

    // ------------------------------------------------------------------
    // Settings: list and disconnect (L6) — work while Ever ID is turned off (FR-5)
    // ------------------------------------------------------------------

    async listIdentities(userId: string): Promise<ExternalIdentityListDto> {
        const rows = await this.identities.listForUser(userId);
        const canDisconnect = await this.canDisconnect(userId);
        const result: ExternalIdentityListDto = { items: [], canDisconnect };
        if (!canDisconnect) result.disconnectBlockedReason = 'last_sign_in_method';
        if (rows.length === 0) return result;

        const status = await this.configurationStatus();
        const displayName = status?.displayName ?? EVER_ID_DEFAULT_DISPLAY_NAME;
        const names = new Map(
            (status?.delegatedClientNames ?? []).map((n) => [n.clientId, n.displayName]),
        );
        result.items = rows.map((row) => this.toDto(row, displayName, names));
        if (status?.accountManagementUrl) result.manageUrl = status.accountManagementUrl;
        return result;
    }

    /**
     * Remove one connected identity of this account (FR-28, FR-29): refused when
     * it would leave no way to sign in (S14); otherwise every other session the
     * identity opened ends and the current one continues (S25).
     */
    async disconnect(
        userId: string,
        identityId: string,
        currentSessionId: string | null,
        ctx: EverIdRequestContext,
    ): Promise<void> {
        const identity = await this.identities.findById(identityId);
        if (!identity || identity.userId !== userId) throw identityNotFound();
        if (!(await this.canDisconnect(userId))) throw everIdError('lastSignInMethod');

        const sessionsEnded = await this.sessions.endByIdentity(identity.id, {
            exceptSessionId: currentSessionId,
            markSignedOut: false,
        });
        const removed = await this.identities.deleteForUser(identity.id, userId);
        if (!removed) throw identityNotFound();

        const displayName = await this.displayName();
        this.activity.disconnected(userId, identity.id, sessionsEnded, displayName, ctx);
        this.events.emit(
            EverIdIdentityUnlinkedEvent.EVENT_NAME,
            new EverIdIdentityUnlinkedEvent({ identityId: identity.id, userId, sessionsEnded }),
        );
        this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.IDENTITY_UNLINKED, { sessionsEnded }, userId);
    }

    /**
     * FR-28: may this account lose its Ever ID? Yes when it keeps a password the
     * person set (a credential account row with a password), another connected
     * social provider, or a verified account e-mail — which can always receive a
     * password-reset link.
     */
    async canDisconnect(userId: string): Promise<boolean> {
        const user = await this.users.findById(userId);
        if (!user) return false;
        if (user.emailVerified) return true;
        const accounts = await this.dataSource
            .getRepository(AuthAccount)
            .find({ where: { userId } });
        return accounts.some((account) => {
            if (account.providerId === 'credential') return !!account.password;
            return !account.providerId.startsWith('plugin:');
        });
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** Record a sign-in through an identity on both rows FR-31/FR-32 keep. */
    async recordSignIn(identityId: string, userId: string): Promise<void> {
        const now = new Date();
        await this.identities.touchLogin(identityId, now);
        await this.users.update(userId, { lastLoginAt: now }).catch(() => undefined);
    }

    /** The provider's display name for Activity rows and the card (FR-2's default otherwise). */
    async displayName(): Promise<string> {
        try {
            return await this.facade.getDisplayName();
        } catch {
            return EVER_ID_DEFAULT_DISPLAY_NAME;
        }
    }

    private async configurationStatus() {
        try {
            return await this.facade.getConfigurationStatus();
        } catch {
            return null;
        }
    }

    private async delegatedClientNames(): Promise<Map<string, string>> {
        const status = await this.configurationStatus();
        return new Map(
            (status?.delegatedClientNames ?? []).map((n) => [n.clientId, n.displayName]),
        );
    }

    private toDto(
        identity: ExternalIdentity,
        displayName: string,
        clientNames: ReadonlyMap<string, string>,
    ): ExternalIdentityDto {
        const windowStart =
            Date.now() - EVER_ID_LIMITS.delegatedClientsWindowDays * 24 * 60 * 60 * 1000;
        const delegated = (
            Array.isArray(identity.delegatedClients) ? identity.delegatedClients : []
        )
            .filter((client) => {
                const seen = Date.parse(client.lastSeenAt);
                return Number.isFinite(seen) && seen >= windowStart;
            })
            .map((client) => ({
                clientId: client.clientId,
                displayName: clientNames.get(client.clientId) ?? client.clientId,
                lastSeenAt: client.lastSeenAt,
            }));
        return {
            id: identity.id,
            displayName,
            email: identity.emailAtLink,
            linkedAt: toIso(identity.linkedAt),
            linkedVia: identity.linkedVia,
            lastLoginAt: identity.lastLoginAt ? toIso(identity.lastLoginAt) : null,
            delegatedClients: delegated,
        };
    }

    private unsealOrInvalid<T>(kind: 'signUp' | 'connect', value: unknown): T {
        try {
            return this.seal.unseal<T>(kind, value);
        } catch (error) {
            if (error instanceof EverIdSealError) throw everIdError('transactionInvalid');
            throw error;
        }
    }
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
