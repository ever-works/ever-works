import { Injectable, Logger } from '@nestjs/common';
import { EVER_ID_LIMITS } from '@ever-works/contracts';
import { IdentityTokenRejectedError } from '@ever-works/plugin';
import { ExternalIdentityRepository, UserRepository } from '@ever-works/agent/database';
import { IdentityProviderFacadeService } from '@ever-works/agent/facades';
import type { AuthenticatedUser, EverIdDelegationBinding } from '../types/auth.types';
import { JWT_SHAPED_BEARER, type EverIdDelegationVerifier } from '../guards/ever-id-guard.tokens';
import { EverIdActivityService } from './ever-id-activity.service';
import { everIdError } from './ever-id-errors';
import { EVER_ID_TELEMETRY_EVENTS, EverIdTelemetryService } from './ever-id-telemetry.service';

/** What a successful delegated authentication answers. */
export interface EverIdDelegatedPrincipal {
    user: AuthenticatedUser;
    binding: EverIdDelegationBinding;
}

/**
 * APW-12 (Ever ID) — the delegated read (spec FR-44..FR-48, plan §5.3): another
 * Ever app reads the person's App Works with a short-lived Ever ID access token
 * carrying a delegated scope, on handlers marked `@DelegatedRead(scope)` only.
 *
 * The token is accepted only if its signature, issuer and audience verify, it
 * has not expired, its lifetime is at most 3,600 s (FR-45) and its subject is a
 * connected identity of an active account. A missing scope is `403
 * insufficientScope`; every other refusal is `null`, which the guard answers
 * with the plain 401 (FR-46). A delegated read never opens a session and never
 * updates the last sign-in time (FR-47); it records the reading app on the
 * identity (FR-48) and writes FR-49's Activity row on the first read per app per
 * 24 hours. Nothing is attempted while Ever ID is turned off.
 */
@Injectable()
export class EverIdDelegationService implements EverIdDelegationVerifier {
    private readonly logger = new Logger(EverIdDelegationService.name);
    private sampleCounter = 0;

    constructor(
        private readonly facade: IdentityProviderFacadeService,
        private readonly identities: ExternalIdentityRepository,
        private readonly users: UserRepository,
        private readonly activity: EverIdActivityService,
        private readonly telemetry: EverIdTelemetryService,
    ) {}

    async authenticate(
        token: string,
        scope: string,
        ctx: { ipAddress: string | null; userAgent: string | null },
    ): Promise<EverIdDelegatedPrincipal | null> {
        if (!JWT_SHAPED_BEARER.test(token)) return null;
        if (!(await this.facade.isEnabled().catch(() => false))) return null;

        let claims: Awaited<ReturnType<IdentityProviderFacadeService['verifyAccessToken']>>;
        try {
            claims = await this.facade.verifyAccessToken(token, {
                requiredScopes: [scope],
                maxLifetimeSeconds: EVER_ID_LIMITS.delegatedTokenMaxLifetimeSeconds,
            });
        } catch (error) {
            if (error instanceof IdentityTokenRejectedError && error.code === 'missingScope') {
                this.sample('insufficientScope');
                throw everIdError('insufficientScope');
            }
            this.sample('rejected');
            return null;
        }

        const identity = await this.identities.findByIssuerSubject(claims.issuer, claims.subject);
        if (!identity) return null;
        const user = await this.users.findById(identity.userId);
        if (!user || !user.isActive) return null;

        const clientId = claims.authorizedParty;
        if (clientId) {
            const { firstInWindow } = await this.identities
                .recordDelegatedClient(identity.id, clientId)
                .catch(() => ({ firstInWindow: false }));
            if (firstInWindow) {
                const clientName = await this.clientName(clientId);
                this.activity.delegatedRead(user.id, identity.id, clientId, clientName, ctx);
            }
        }
        this.sample('ok');

        const principal: AuthenticatedUser = {
            userId: user.id,
            email: user.email,
            username: user.username,
            provider: user.registrationProvider,
            emailVerified: user.emailVerified,
            isActive: user.isActive,
            avatar: user.avatar || null,
            iat: Math.floor(Date.now() / 1000),
            iss: 'ever-works',
            aud: 'ever-works',
            authMethod: 'ever-id-delegated',
        };
        return {
            user: principal,
            binding: { identityId: identity.id, clientId, scopes: [...claims.scopes] },
        };
    }

    private async clientName(clientId: string): Promise<string> {
        try {
            const status = await this.facade.getConfigurationStatus();
            return (
                status.delegatedClientNames.find((entry) => entry.clientId === clientId)
                    ?.displayName ?? clientId
            );
        } catch {
            return clientId;
        }
    }

    /** Plan §9.1: the delegated-read counter is sampled 1 in 10. */
    private sample(result: 'ok' | 'insufficientScope' | 'rejected') {
        this.sampleCounter = (this.sampleCounter + 1) % 10;
        if (this.sampleCounter === 1) {
            this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.DELEGATED_READ, { result });
        }
    }
}
