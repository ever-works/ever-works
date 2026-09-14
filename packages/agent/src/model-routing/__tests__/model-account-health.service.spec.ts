import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { ModelAccountHealthService } from '../model-account-health.service';
import type { ModelProviderCatalogService } from '../model-provider-catalog.service';
import { InMemoryModelAccounts, providerDescriptor } from './model-routing.fakes';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const inDays = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

describe('ModelAccountHealthService', () => {
    let store: InMemoryModelAccounts;
    let getSettings: jest.Mock;

    function serviceWith(plugin: Parameters<typeof providerDescriptor>[1]) {
        const descriptor = providerDescriptor('provider-a', plugin);
        const providers = {
            getProvider: jest.fn(async (id: string) => (id === 'provider-a' ? descriptor : null)),
        } as unknown as ModelProviderCatalogService;
        return {
            descriptor,
            service: new ModelAccountHealthService(store.asRepository(), providers, {
                getSettings,
            } as unknown as PluginSettingsService),
        };
    }

    beforeEach(() => {
        store = new InMemoryModelAccounts();
        // A key configured elsewhere must never make a candidate pass.
        getSettings = jest.fn().mockResolvedValue({
            apiKey: 'sk-configured-elsewhere',
            baseUrl: 'https://operator.example/v1',
        });
    });

    describe('checkCredentials', () => {
        it("prefers the plugin's own identity check and passes only the candidate secret", async () => {
            const checkCredential = jest.fn().mockResolvedValue({ ok: true, expiresAt: inDays(9) });
            const isAvailable = jest.fn();
            const { service, descriptor } = serviceWith({ checkCredential, isAvailable });
            const result = await service.checkCredentials(
                descriptor,
                { apiKey: 'sk-candidate' },
                'u1',
            );
            expect(result).toEqual({ ok: true, rejected: false, expiresAt: inDays(9) });
            expect(checkCredential).toHaveBeenCalledWith({
                apiKey: 'sk-candidate',
                baseUrl: 'https://operator.example/v1',
            });
            expect(isAvailable).not.toHaveBeenCalled();
            expect(getSettings).toHaveBeenCalledWith('provider-a', {
                userId: 'u1',
                includeSecrets: false,
            });
        });

        it('falls back to the connection test when the plugin declares no identity check', async () => {
            const isAvailable = jest.fn().mockResolvedValue(false);
            const { service, descriptor } = serviceWith({ isAvailable });
            await expect(
                service.checkCredentials(descriptor, { apiKey: 'sk-bad' }, 'u1'),
            ).resolves.toEqual({ ok: false, rejected: true, expiresAt: null });
            expect(isAvailable).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-bad' }));
        });

        it('separates a refusal from a check that could not run', async () => {
            const { service: refused, descriptor } = serviceWith({
                isAvailable: jest
                    .fn()
                    .mockRejectedValue(Object.assign(new Error('no'), { status: 401 })),
            });
            await expect(
                refused.checkCredentials(descriptor, { apiKey: 'k' }, 'u1'),
            ).resolves.toMatchObject({ ok: false, rejected: true });

            const { service: offline, descriptor: second } = serviceWith({
                isAvailable: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
            });
            await expect(
                offline.checkCredentials(second, { apiKey: 'k' }, 'u1'),
            ).resolves.toMatchObject({ ok: false, rejected: false });
        });
    });

    describe('probe', () => {
        it('marks a working account expiring 14 days before a known expiry', async () => {
            const { service } = serviceWith({
                checkCredential: jest.fn().mockResolvedValue({ ok: true, expiresAt: inDays(9) }),
            });
            const account = store.seed({ health: 'unknown' });
            await expect(service.probe(account, NOW)).resolves.toBe('expiring');
            expect(store.rows[0]).toMatchObject({
                health: 'expiring',
                lastCheckedAt: NOW,
                credentialExpiresAt: inDays(9),
                position: 1,
            });
        });

        it('sets unknown — never invalid — when the check could not run', async () => {
            const { service } = serviceWith({
                isAvailable: jest.fn().mockRejectedValue(new Error('timeout')),
            });
            const account = store.seed({ health: 'working' });
            await expect(service.probe(account, NOW)).resolves.toBe('unknown');
        });

        it('keeps a known rejection when a later check could not run', async () => {
            const { service } = serviceWith({
                isAvailable: jest.fn().mockRejectedValue(new Error('timeout')),
            });
            const account = store.seed({ health: 'invalid' });
            await expect(service.probe(account, NOW)).resolves.toBe('invalid');
        });

        it('sets invalid when the provider refuses the stored credential', async () => {
            const { service } = serviceWith({ isAvailable: jest.fn().mockResolvedValue(false) });
            const account = store.seed({ health: 'working' });
            await expect(service.probe(account, NOW)).resolves.toBe('invalid');
        });

        it('reads a removed provider as unknown without throwing', async () => {
            const { service } = serviceWith({});
            const account = store.seed({ providerPluginId: 'uninstalled' });
            await expect(service.probe(account, NOW)).resolves.toBe('unknown');
        });
    });

    describe('probeDueAccounts', () => {
        it('checks only enabled accounts not checked for six hours, once each', async () => {
            const { service } = serviceWith({ isAvailable: jest.fn().mockResolvedValue(true) });
            store.seed({ label: 'never checked', lastCheckedAt: null });
            store.seed({ label: 'stale', lastCheckedAt: new Date(NOW.getTime() - 7 * 3600_000) });
            store.seed({ label: 'fresh', lastCheckedAt: new Date(NOW.getTime() - 3600_000) });
            store.seed({ label: 'paused', enabled: false, lastCheckedAt: null });

            const sweep = await service.probeDueAccounts({ now: NOW });
            expect(sweep).toEqual({ scanned: 2, checked: 2, health: { working: 2 } });

            // An immediate second tick finds nothing due.
            const again = await service.probeDueAccounts({ now: NOW });
            expect(again.checked).toBe(0);
        });

        it('skips an account another tick already claimed, and survives a failing probe', async () => {
            const { service } = serviceWith({ isAvailable: jest.fn().mockResolvedValue(true) });
            store.seed({ label: 'claimed elsewhere', lastCheckedAt: null });
            store.seed({ label: 'will throw', lastCheckedAt: null });
            store.repository.claimForCheck
                .mockResolvedValueOnce(false)
                .mockImplementationOnce(async () => {
                    throw new Error('db blip');
                });
            await expect(service.probeDueAccounts({ now: NOW })).resolves.toMatchObject({
                scanned: 2,
                checked: 0,
            });
        });
    });

    it('marks an account invalid at once when a live call is refused', async () => {
        const { service } = serviceWith({});
        const account = store.seed({ health: 'working' });
        await service.applyLiveRejection(account.id, NOW);
        expect(store.rows[0]).toMatchObject({ health: 'invalid', position: 1 });
    });
});
