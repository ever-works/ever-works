import { UsagePayer } from '@src/entities/_types';
import { payerFromResolvedSettings, SettingsUsagePayerResolver } from './usage-payer-resolver';

const setting = (key: string, value: unknown, source: string) => ({
    key,
    value,
    source,
    isFallback: false,
});

describe('payerFromResolvedSettings', () => {
    it('lets apiKey decide when the plugin has one', () => {
        expect(
            payerFromResolvedSettings({ apiKey: setting('apiKey', 'sk', 'user') } as never),
        ).toBe(UsagePayer.WORKSPACE);
        expect(
            payerFromResolvedSettings({ apiKey: setting('apiKey', 'sk', 'work') } as never),
        ).toBe(UsagePayer.WORKSPACE);
        expect(payerFromResolvedSettings({ apiKey: setting('apiKey', 'sk', 'env') } as never)).toBe(
            UsagePayer.PLATFORM,
        );
    });

    it('falls back to another credential-shaped setting that holds a value', () => {
        const resolved = {
            baseUrl: setting('baseUrl', 'https://x', 'user'),
            accessKey: setting('accessKey', 'ak', 'user'),
        };
        expect(payerFromResolvedSettings(resolved as never)).toBe(UsagePayer.WORKSPACE);
        const platform = { accessKey: setting('accessKey', 'ak', 'admin') };
        expect(payerFromResolvedSettings(platform as never)).toBe(UsagePayer.PLATFORM);
    });

    it('ignores empty credential settings and treats a credential-less plugin as platform-run', () => {
        const resolved = {
            token: setting('token', '', 'user'),
            model: setting('model', 'x', 'user'),
        };
        expect(payerFromResolvedSettings(resolved as never)).toBe(UsagePayer.PLATFORM);
    });

    it('is unconfirmed when nothing was resolved', () => {
        expect(payerFromResolvedSettings(null)).toBe(UsagePayer.UNCONFIRMED);
        expect(payerFromResolvedSettings(undefined)).toBe(UsagePayer.UNCONFIRMED);
    });
});

describe('SettingsUsagePayerResolver', () => {
    function makeSettings(impl: (...args: unknown[]) => unknown) {
        return { getResolvedSettings: jest.fn(impl) };
    }

    afterEach(() => {
        jest.useRealTimers();
    });

    it('resolves provenance with secrets included, scoped to the user and Work', async () => {
        const settings = makeSettings(async () => ({ apiKey: setting('apiKey', 'sk', 'user') }));
        const resolver = new SettingsUsagePayerResolver(settings as never);

        await expect(
            resolver.resolve({ pluginId: 'search-a', userId: 'u-1', workId: 'w-1' }),
        ).resolves.toBe(UsagePayer.WORKSPACE);
        expect(settings.getResolvedSettings).toHaveBeenCalledWith('search-a', {
            userId: 'u-1',
            workId: 'w-1',
            includeSecrets: true,
        });
    });

    it('never rejects: a resolution failure is unconfirmed and is not memoised', async () => {
        const settings = makeSettings(async () => {
            throw new Error('registry down');
        });
        const resolver = new SettingsUsagePayerResolver(settings as never);

        await expect(resolver.resolve({ pluginId: 'p', userId: 'u' })).resolves.toBe(
            UsagePayer.UNCONFIRMED,
        );
        await resolver.resolve({ pluginId: 'p', userId: 'u' });
        expect(settings.getResolvedSettings).toHaveBeenCalledTimes(2);
    });

    it('memoises a confirmed answer for a short window, then reads again', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-14T10:00:00.000Z'));
        const settings = makeSettings(async () => ({ apiKey: setting('apiKey', 'sk', 'env') }));
        const resolver = new SettingsUsagePayerResolver(settings as never);

        await resolver.resolve({ pluginId: 'p', userId: 'u' });
        await resolver.resolve({ pluginId: 'p', userId: 'u' });
        expect(settings.getResolvedSettings).toHaveBeenCalledTimes(1);

        jest.setSystemTime(Date.now() + SettingsUsagePayerResolver.MEMO_TTL_MS + 1);
        await resolver.resolve({ pluginId: 'p', userId: 'u' });
        expect(settings.getResolvedSettings).toHaveBeenCalledTimes(2);
    });

    it('keys the memo by Work, so two Works never share an answer', async () => {
        const settings = makeSettings(async (_pluginId: unknown, options: unknown) => ({
            apiKey: setting(
                'apiKey',
                'sk',
                (options as { workId?: string }).workId ? 'work' : 'env',
            ),
        }));
        const resolver = new SettingsUsagePayerResolver(settings as never);

        await expect(resolver.resolve({ pluginId: 'p', userId: 'u', workId: 'w' })).resolves.toBe(
            UsagePayer.WORKSPACE,
        );
        await expect(resolver.resolve({ pluginId: 'p', userId: 'u' })).resolves.toBe(
            UsagePayer.PLATFORM,
        );
    });

    it('answers a fleet node row without a settings read', async () => {
        const settings = makeSettings(async () => ({}));
        const resolver = new SettingsUsagePayerResolver(settings as never);

        await expect(resolver.resolve({ pluginId: 'fleet-node:codex', userId: 'u' })).resolves.toBe(
            UsagePayer.WORKSPACE,
        );
        expect(settings.getResolvedSettings).not.toHaveBeenCalled();
    });

    it('is unconfirmed with no settings service bound', async () => {
        const resolver = new SettingsUsagePayerResolver();
        await expect(resolver.resolve({ pluginId: 'p', userId: 'u' })).resolves.toBe(
            UsagePayer.UNCONFIRMED,
        );
    });
});
