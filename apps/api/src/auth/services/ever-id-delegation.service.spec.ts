jest.mock('@ever-works/agent/database', () => ({
    ExternalIdentityRepository: class ExternalIdentityRepository {},
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    IdentityProviderFacadeService: class IdentityProviderFacadeService {},
}));
jest.mock('./ever-id-activity.service', () => ({
    EverIdActivityService: class EverIdActivityService {},
}));
jest.mock('./ever-id-telemetry.service', () => ({
    EverIdTelemetryService: class EverIdTelemetryService {},
    EVER_ID_TELEMETRY_EVENTS: { DELEGATED_READ: 'ever_id.delegated_read' },
}));

import { EVER_ID_TRUSTED_CLIENT_IDS_ENV } from '../ever-id-trusted-clients';
import { EverIdDelegationService } from './ever-id-delegation.service';

/**
 * The delegated read's token rules as the delegation service hands them to the identity
 * provider (APW-12 FR-45, FR-46), and the one rule it adds on request:
 * `EVER_ID_TRUSTED_CLIENT_IDS` becomes the plugin's `allowedAuthorizedParties`. The plugin's
 * own enforcement of that list (`badAuthorizedParty`) is pinned by its access-token spec, and
 * the end-to-end refusal by `launcher-delegated-read.integration.spec.ts`.
 */

const TOKEN = 'aaaa.bbbb.cccc';

function build(trusted: string | undefined, nodeEnv = 'test') {
    const previous = {
        trusted: process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV],
        nodeEnv: process.env.NODE_ENV,
    };
    if (trusted === undefined) delete process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV];
    else process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV] = trusted;
    process.env.NODE_ENV = nodeEnv;

    const facade = {
        isEnabled: jest.fn().mockResolvedValue(true),
        verifyAccessToken: jest.fn().mockResolvedValue({
            issuer: 'https://id.example.test',
            subject: 'subject-1',
            audience: ['ever-works'],
            scopes: ['apps:read'],
            authorizedParty: 'app-ever-co',
            issuedAt: 1,
            expiresAt: 2,
            jti: null,
        }),
        getConfigurationStatus: jest.fn().mockResolvedValue({ delegatedClientNames: [] }),
    };
    const identities = {
        findByIssuerSubject: jest.fn().mockResolvedValue({ id: 'identity-1', userId: 'user-1' }),
        recordDelegatedClient: jest.fn().mockResolvedValue({ firstInWindow: false }),
    };
    const users = {
        findById: jest.fn().mockResolvedValue({
            id: 'user-1',
            email: 'a@example.com',
            username: 'a',
            registrationProvider: 'local',
            emailVerified: true,
            isActive: true,
            avatar: null,
        }),
    };
    const activity = { delegatedRead: jest.fn() };
    const telemetry = { emit: jest.fn() };

    try {
        const service = new EverIdDelegationService(
            facade as never,
            identities as never,
            users as never,
            activity as never,
            telemetry as never,
        );
        return { service, facade };
    } finally {
        if (previous.trusted === undefined) delete process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV];
        else process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV] = previous.trusted;
        process.env.NODE_ENV = previous.nodeEnv;
    }
}

const CTX = { ipAddress: null, userAgent: null };

describe('EverIdDelegationService — the token rules it asks the provider to apply', () => {
    it('without trusted clients, passes no authorised-party rule: FR-45 exactly as written', async () => {
        const { service, facade } = build(undefined);

        await expect(service.authenticate(TOKEN, 'apps:read', CTX)).resolves.not.toBeNull();
        const rules = facade.verifyAccessToken.mock.calls[0][1];
        expect(rules).toEqual({ requiredScopes: ['apps:read'], maxLifetimeSeconds: 3_600 });
        expect(rules).not.toHaveProperty('allowedAuthorizedParties');
    });

    it('an empty value (an unset variable rendered by a manifest) is the same as unset', async () => {
        const { service, facade } = build('');

        await service.authenticate(TOKEN, 'apps:read', CTX);
        expect(facade.verifyAccessToken.mock.calls[0][1]).not.toHaveProperty(
            'allowedAuthorizedParties',
        );
    });

    it('with trusted clients, requires the token to be minted for one of them', async () => {
        const { service, facade } = build('app-ever-co, launcher-two');

        await service.authenticate(TOKEN, 'apps:read', CTX);
        expect(facade.verifyAccessToken).toHaveBeenCalledWith(TOKEN, {
            requiredScopes: ['apps:read'],
            maxLifetimeSeconds: 3_600,
            allowedAuthorizedParties: ['app-ever-co', 'launcher-two'],
        });
    });

    it('answers a token refused for its authorised party with null — the guard’s plain 401', async () => {
        const { service, facade } = build('app-ever-co');
        facade.verifyAccessToken.mockRejectedValueOnce(
            Object.assign(new Error('badAuthorizedParty'), {
                name: 'IdentityTokenRejectedError',
                code: 'badAuthorizedParty',
            }),
        );

        await expect(service.authenticate(TOKEN, 'apps:read', CTX)).resolves.toBeNull();
    });

    it('reads the list once, at construction: a later change needs a restart', async () => {
        const { service, facade } = build('app-ever-co');
        process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV] = 'someone-else';
        try {
            await service.authenticate(TOKEN, 'apps:read', CTX);
        } finally {
            delete process.env[EVER_ID_TRUSTED_CLIENT_IDS_ENV];
        }
        expect(facade.verifyAccessToken.mock.calls[0][1].allowedAuthorizedParties).toEqual([
            'app-ever-co',
        ]);
    });

    it('a misconfigured value stops a production boot', () => {
        expect(() => build('not a client id', 'production')).toThrow(/EVER_ID_TRUSTED_CLIENT_IDS/);
    });
});
