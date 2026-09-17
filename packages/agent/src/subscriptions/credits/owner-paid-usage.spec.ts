import { isOwnerPaidUsage } from './owner-paid-usage';

/**
 * The one rule for "the owner's own credentials served this usage". Pinned
 * here so run-cost settlement and any other caller agree on it.
 */
describe('isOwnerPaidUsage', () => {
    const ACCOUNT = { workspaceKey: 'org:org-1', providerPluginId: 'openrouter' };

    it('fleet node spend is owner-paid from the plugin id alone', () => {
        expect(isOwnerPaidUsage({ pluginId: 'fleet-node:claude-code' })).toBe(true);
    });

    it('a key resolved from the user or work settings level is owner-paid', () => {
        expect(isOwnerPaidUsage({ pluginId: 'openrouter', apiKeySource: 'user' })).toBe(true);
        expect(isOwnerPaidUsage({ pluginId: 'openrouter', apiKeySource: 'work' })).toBe(true);
    });

    it('a platform-supplied or unresolved key is not', () => {
        for (const apiKeySource of ['admin', 'env', 'default', null, undefined] as const) {
            expect(isOwnerPaidUsage({ pluginId: 'openrouter', apiKeySource })).toBe(false);
        }
    });

    it('a Model Account of the same workspace and provider is owner-paid', () => {
        expect(
            isOwnerPaidUsage({
                pluginId: 'openrouter',
                apiKeySource: 'env',
                modelAccountId: 'acc-1',
                modelAccount: ACCOUNT,
                workspaceKey: 'org:org-1',
            }),
        ).toBe(true);
    });

    it('a Model Account of another workspace, another provider, or not found is not honoured', () => {
        const base = { pluginId: 'openrouter', modelAccountId: 'acc-1', workspaceKey: 'org:org-1' };
        expect(
            isOwnerPaidUsage({
                ...base,
                modelAccount: { ...ACCOUNT, workspaceKey: 'org:org-2' },
            }),
        ).toBe(false);
        expect(
            isOwnerPaidUsage({
                ...base,
                modelAccount: { ...ACCOUNT, workspaceKey: 'user:user-1' },
            }),
        ).toBe(false);
        expect(
            isOwnerPaidUsage({
                ...base,
                modelAccount: { ...ACCOUNT, providerPluginId: 'anthropic' },
            }),
        ).toBe(false);
        expect(isOwnerPaidUsage({ ...base, modelAccount: null })).toBe(false);
    });

    it('an account without a known workspace to compare against is not honoured', () => {
        expect(
            isOwnerPaidUsage({
                pluginId: 'openrouter',
                modelAccountId: 'acc-1',
                modelAccount: ACCOUNT,
            }),
        ).toBe(false);
        expect(
            isOwnerPaidUsage({
                pluginId: 'openrouter',
                modelAccount: ACCOUNT,
                workspaceKey: 'org:org-1',
            }),
        ).toBe(false);
    });
});
