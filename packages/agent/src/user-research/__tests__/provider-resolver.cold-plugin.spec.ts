import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { resolveSearchProviderIds } from '../provider-resolver';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import {
    createRegistry,
    registerColdPlugin,
    requiredSecretSchema,
} from '../../plugins/__tests__/cold-plugin.fixture';

/**
 * Research search-provider selection keeps only providers whose required
 * settings are configured. For a provider the registry still holds as a COLD
 * lazy proxy, the required list must come from the plugin class's schema —
 * not from the proxy's `{}`, which would make every provider look configured.
 */
describe('resolveSearchProviderIds — cold lazy search providers', () => {
    function build(settingsByPlugin: Record<string, Record<string, unknown>>) {
        const registry = createRegistry();
        for (const id of ['cold-search-a', 'cold-search-b']) {
            registerColdPlugin(registry, {
                id,
                category: 'search',
                capabilities: [PLUGIN_CAPABILITIES.SEARCH],
                settingsSchema: requiredSecretSchema(),
                manifest: { autoEnable: true },
            });
        }
        const settingsService = {
            getSettings: jest.fn(async (pluginId: string) => settingsByPlugin[pluginId] ?? {}),
        } as unknown as PluginSettingsService;
        return { registry, settingsService };
    }

    it('skips a cold provider whose required API key is not configured', async () => {
        const { registry, settingsService } = build({ 'cold-search-b': { apiKey: 'sk-b' } });

        await expect(
            resolveSearchProviderIds(registry, 'user-1', settingsService),
        ).resolves.toEqual(['cold-search-b']);
    });

    it('skips a provider that cannot be loaded', async () => {
        const { registry, settingsService } = build({
            'cold-search-a': { apiKey: 'sk-a' },
            'cold-search-broken': { apiKey: 'sk-broken' },
        });
        registerColdPlugin(registry, {
            id: 'cold-search-broken',
            category: 'search',
            capabilities: [PLUGIN_CAPABILITIES.SEARCH],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            failing: true,
        });

        await expect(
            resolveSearchProviderIds(registry, 'user-1', settingsService),
        ).resolves.toEqual(['cold-search-a']);
        expect(registry.get('cold-search-broken')?.state).toBe('error');
    });
});
