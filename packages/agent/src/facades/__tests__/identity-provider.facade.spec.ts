import { IdentityTokenRejectedError, PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { IdentityProviderCheck } from '@ever-works/plugin';
import {
    IdentityProviderFacadeService,
    IdentityProviderUnavailableError,
    normalizeIdentityProviderError,
} from '../identity-provider.facade';
import type { PluginRepository } from '../../plugins/repositories/plugin.repository';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { createRegistry, registerColdPlugin } from '../../plugins/__tests__/cold-plugin.fixture';

/**
 * APW-12 (Ever ID) — the identity provider facade (plan §4.4).
 *
 * The property this spec exists for is the kill switch: while no administrator
 * has turned Ever ID on, the facade answers from the database alone — the plugin
 * is not even LOADED (a cold lazy proxy stays cold), so nothing can reach an
 * identity provider (FR-5, program rule "switched off ⇒ zero outbound calls").
 */

const ALL_CHECKS_OK: IdentityProviderCheck[] = [
    { id: 'discovery', ok: true },
    { id: 'issuerMatch', ok: true },
    { id: 'endpoints', ok: true },
    { id: 'pkceS256', ok: true },
    { id: 'signingAlg', ok: true },
    { id: 'backchannelLogout', ok: true },
    { id: 'deviceAuthorization', ok: false },
];

function identityPluginMembers(overrides: Record<string, unknown> = {}) {
    return {
        testConnection: jest.fn(async () => ALL_CHECKS_OK),
        getPublicConfig: jest.fn(async () => ({
            issuer: 'https://id.example.test',
            displayName: 'Example ID',
            localClients: [],
            apiAudience: 'ever-works',
            signUpAllowed: true,
        })),
        buildAuthorizationRequest: jest.fn(async () => ({
            url: 'https://id.example.test/authorize?x=1',
            state: 's',
            nonce: 'n',
            codeVerifier: 'v',
        })),
        exchangeAuthorizationCode: jest.fn(),
        verifyAccessToken: jest.fn(),
        verifyLogoutToken: jest.fn(),
        buildEndSessionUrl: jest.fn(async () => null),
        ...overrides,
    };
}

function setup(
    options: { settings?: Record<string, unknown>; members?: Record<string, unknown> } = {},
) {
    const registry = createRegistry();
    const members = identityPluginMembers(options.members);
    const cold = registerColdPlugin(registry, {
        id: 'example-identity',
        category: 'identity',
        capabilities: [PLUGIN_CAPABILITIES.IDENTITY_PROVIDER],
        configurationMode: 'admin-only',
        settingsSchema: {
            type: 'object',
            properties: { issuerUrl: { type: 'string' }, clientSecret: { type: 'string' } },
            required: ['issuerUrl', 'clientSecret'],
        } as never,
        members,
    });
    let row: { settings: Record<string, unknown> } | null = {
        settings: { ...(options.settings ?? {}) },
    };
    const pluginRepository = {
        findByPluginId: jest.fn(async () => row),
        updateSettings: jest.fn(async (_id: string, settings: Record<string, unknown>) => {
            row = { settings };
            return row;
        }),
    };
    const settingsService = {
        getResolvedSettings: jest.fn(async () => ({
            issuerUrl: {
                key: 'issuerUrl',
                value: 'https://id.example.test',
                source: 'env',
                isFallback: true,
            },
            clientSecret: {
                key: 'clientSecret',
                value: 'redacted',
                source: 'env',
                isFallback: true,
            },
        })),
    };
    const facade = new IdentityProviderFacadeService(
        registry,
        pluginRepository as unknown as PluginRepository,
        settingsService as unknown as PluginSettingsService,
    );
    return { facade, cold, members, pluginRepository, settingsService, row: () => row };
}

describe('IdentityProviderFacadeService', () => {
    describe('while no administrator turned it on', () => {
        it('reports registered-but-disabled from the database without loading the plugin', async () => {
            const { facade, cold } = setup();

            await expect(facade.getState()).resolves.toEqual({
                registered: true,
                enabled: false,
                unavailableSince: null,
            });
            await expect(facade.isEnabled()).resolves.toBe(false);
            await expect(facade.isAvailable()).resolves.toBe(false);
            await expect(facade.getDisplayName()).resolves.toBe('Ever ID');
            expect(cold.loads()).toBe(0);
        });

        it('refuses every sign-in pass-through with `disabled` and never calls the plugin', async () => {
            const { facade, cold, members } = setup();

            for (const call of [
                () => facade.getPublicConfig(),
                () =>
                    facade.buildAuthorizationRequest({
                        redirectUri: 'https://app.example.test/cb',
                    }),
                () =>
                    facade.exchangeAuthorizationCode({
                        code: 'c',
                        redirectUri: 'https://app.example.test/cb',
                        codeVerifier: 'v',
                        expectedNonce: 'n',
                    }),
                () =>
                    facade.verifyAccessToken('a.b.c', {
                        requiredScopes: ['apps:read'],
                        maxLifetimeSeconds: 3600,
                    }),
                () =>
                    facade.buildEndSessionUrl({
                        postLogoutRedirectUri: 'https://app.example.test',
                        state: 's',
                    }),
            ]) {
                await expect(call()).rejects.toEqual(
                    new IdentityProviderUnavailableError('disabled'),
                );
            }
            expect(cold.loads()).toBe(0);
            expect(members.buildAuthorizationRequest).not.toHaveBeenCalled();
        });

        it('only a strict `true` counts as enabled', async () => {
            for (const enabled of ['true', 1, {}, null]) {
                const { facade } = setup({ settings: { enabled } });
                await expect(facade.isEnabled()).resolves.toBe(false);
            }
        });

        it('still lets an administrator test the connection (FR-3: test before switching on)', async () => {
            const { facade, members } = setup();

            await expect(facade.testConnection()).resolves.toEqual(ALL_CHECKS_OK);
            expect(members.testConnection).toHaveBeenCalledTimes(1);
        });
    });

    describe('enable / disable (the API kill switch, FR-5)', () => {
        it('persists `enabled` in the plugin settings row, keeps every other key, and takes effect at once', async () => {
            const { facade, pluginRepository, row } = setup({ settings: { displayName: 'Kept' } });

            await facade.setEnabled(true);

            expect(pluginRepository.updateSettings).toHaveBeenCalledTimes(1);
            expect(row()?.settings).toEqual({ displayName: 'Kept', enabled: true });
            await expect(facade.isEnabled()).resolves.toBe(true);
            await expect(facade.isAvailable()).resolves.toBe(true);

            await facade.setEnabled(false);
            await expect(facade.isEnabled()).resolves.toBe(false);
        });

        it('passes calls through once enabled', async () => {
            const { facade, members } = setup({ settings: { enabled: true } });

            await expect(
                facade.buildAuthorizationRequest({ redirectUri: 'https://app.example.test/cb' }),
            ).resolves.toMatchObject({ state: 's' });
            expect(members.buildAuthorizationRequest).toHaveBeenCalledWith({
                redirectUri: 'https://app.example.test/cb',
            });
            await expect(facade.getDisplayName()).resolves.toBe('Example ID');
        });
    });

    describe('availability (FR-14: a failing test keeps sign-in off until a re-test passes)', () => {
        it('marks the provider unavailable when a required check fails, and clears it on a passing run', async () => {
            const failing = ALL_CHECKS_OK.map((check) =>
                check.id === 'issuerMatch' ? { ...check, ok: false } : check,
            );
            const testConnection = jest.fn(async () => failing);
            const { facade, row } = setup({
                settings: { enabled: true },
                members: { testConnection },
            });

            await facade.testConnection();
            const marked = row()?.settings.availability as { unavailableSince?: string };
            expect(typeof marked.unavailableSince).toBe('string');
            await expect(facade.isAvailable()).resolves.toBe(false);
            await expect(
                facade.buildAuthorizationRequest({ redirectUri: 'https://app.example.test/cb' }),
            ).rejects.toEqual(new IdentityProviderUnavailableError('unavailable'));

            testConnection.mockResolvedValueOnce(ALL_CHECKS_OK);
            await facade.testConnection();
            const cleared = row()?.settings.availability as { unavailableSince?: string };
            expect(cleared.unavailableSince).toBeUndefined();
            await expect(facade.isAvailable()).resolves.toBe(true);
        });

        it('records the last sign-out notice for the Health view (spec §6.7)', async () => {
            const { facade } = setup();
            const at = new Date('2026-09-02T12:00:00.000Z');

            await facade.recordLogoutNotice(at);

            await expect(facade.getHealth()).resolves.toMatchObject({
                lastLogoutNoticeAt: at.toISOString(),
            });
        });
    });

    describe('no identity provider in this build', () => {
        it('answers `notRegistered` and never enabled', async () => {
            const registry = createRegistry();
            const facade = new IdentityProviderFacadeService(
                registry,
                { findByPluginId: jest.fn() } as unknown as PluginRepository,
                {} as unknown as PluginSettingsService,
            );

            await expect(facade.getState()).resolves.toEqual({
                registered: false,
                enabled: false,
                unavailableSince: null,
            });
            await expect(facade.testConnection()).rejects.toEqual(
                new IdentityProviderUnavailableError('notRegistered'),
            );
            await expect(facade.setEnabled(true)).rejects.toEqual(
                new IdentityProviderUnavailableError('notRegistered'),
            );
        });
    });

    describe('normalizeIdentityProviderError — the plugin may bundle its own copy of the contract', () => {
        it('re-creates a token refusal from a foreign class by its name and closed code', () => {
            class ForeignRejection extends Error {
                constructor(readonly code: string) {
                    super(code);
                    this.name = 'IdentityTokenRejectedError';
                }
            }
            const normalized = normalizeIdentityProviderError(new ForeignRejection('badNonce'));

            expect(normalized).toBeInstanceOf(IdentityTokenRejectedError);
            expect((normalized as IdentityTokenRejectedError).code).toBe('badNonce');
        });

        it('maps an unconfigured plugin to `notConfigured` and anything else to `unavailable`', () => {
            expect(
                normalizeIdentityProviderError(
                    Object.assign(new Error('x'), { reason: 'notConfigured' }),
                ),
            ).toEqual(new IdentityProviderUnavailableError('notConfigured'));
            expect(
                normalizeIdentityProviderError(
                    Object.assign(new Error('x'), { reason: 'issuerDrift' }),
                ),
            ).toEqual(new IdentityProviderUnavailableError('unavailable'));
            // An unknown code is never treated as a known refusal.
            const unknown = Object.assign(new Error('x'), {
                name: 'IdentityTokenRejectedError',
                code: 'novel',
            });
            expect(normalizeIdentityProviderError(unknown)).toEqual(
                new IdentityProviderUnavailableError('unavailable'),
            );
        });

        it('normalises errors thrown through a pass-through', async () => {
            const foreign = Object.assign(new Error('expired'), {
                name: 'IdentityTokenRejectedError',
                code: 'expired',
            });
            const { facade } = setup({
                settings: { enabled: true },
                members: { verifyLogoutToken: jest.fn(async () => Promise.reject(foreign)) },
            });

            await expect(facade.verifyLogoutToken('a.b.c')).rejects.toBeInstanceOf(
                IdentityTokenRejectedError,
            );
        });
    });

    describe('administrator settings', () => {
        it('clears a value sent as null and never writes the switch through the settings path', async () => {
            const { facade, settingsService } = setup();
            const updateAdminSettings = jest.fn(async () => undefined);
            (settingsService as unknown as { updateAdminSettings: jest.Mock }).updateAdminSettings =
                updateAdminSettings;

            const fields = await facade.updateSettings({
                accountManagementUrl: null,
                displayName: 'Example ID',
                enabled: true,
            });

            expect(fields).toEqual(['accountManagementUrl', 'displayName']);
            expect(updateAdminSettings).toHaveBeenCalledTimes(1);
            const [, written] = updateAdminSettings.mock.calls[0] as unknown as [
                string,
                Record<string, unknown>,
            ];
            expect(written).toEqual({ accountManagementUrl: undefined, displayName: 'Example ID' });
            expect('accountManagementUrl' in written).toBe(true);
            expect('enabled' in written).toBe(false);
        });
    });

    describe('configuration status', () => {
        it('lists the terminal clients for the administration page, dropping malformed entries, never a secret', async () => {
            const { facade, cold, settingsService } = setup();
            settingsService.getResolvedSettings.mockResolvedValueOnce({
                issuerUrl: {
                    key: 'issuerUrl',
                    value: 'https://id.example.test',
                    source: 'env',
                    isFallback: true,
                },
                clientSecret: {
                    key: 'clientSecret',
                    value: 'top-secret-value',
                    source: 'env',
                    isFallback: true,
                },
                localClients: {
                    key: 'localClients',
                    value: [
                        { kind: 'cli', clientId: 'cli-client' },
                        { kind: 'desktop', clientId: 'not-a-kind' },
                        { kind: 'node', clientId: '' },
                        { kind: 'node', clientId: 'node-client' },
                    ],
                    source: 'admin',
                    isFallback: false,
                },
            } as never);

            const status = await facade.getConfigurationStatus();

            expect(status.localClients).toBe(4);
            expect(status.localClientList).toEqual([
                { kind: 'cli', clientId: 'cli-client' },
                { kind: 'node', clientId: 'node-client' },
            ]);
            expect(status.clientSecretSet).toBe(true);
            expect(JSON.stringify(status)).not.toContain('top-secret-value');
            expect(cold.loads()).toBe(0);
        });
    });
});
