import { Logger } from '@nestjs/common';
import { CodeEditFacadeService } from '../code-edit.facade';
import type { AiFacadeService } from '../ai.facade';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import {
    createRegistry,
    registerColdPlugin,
    requiredSecretSchema,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const CODE_EDIT = 'code-edit';

/**
 * `getProviderForUser` answers what the Template customisation flow needs to
 * know about a code-edit provider — notably the provider categories it lets
 * the user pick (`selectableProviderCategories`), which claude-code, codex,
 * gemini and opencode declare only in their class's getManifest(). A cold
 * lazy proxy's registry entry does not carry that until the plugin loads.
 */
describe('CodeEditFacadeService.getProviderForUser — cold lazy code-edit providers', () => {
    function build() {
        const registry = createRegistry();
        const facade = new CodeEditFacadeService(
            registry,
            {} as PluginSettingsService,
            {} as AiFacadeService,
        );
        return { registry, facade };
    }

    it('answers the selectable categories, default and icon a cold provider declares in getManifest()', async () => {
        const { registry, facade } = build();
        registerColdPlugin(registry, {
            id: 'cold-code-edit',
            capabilities: [CODE_EDIT],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: {
                selectableProviderCategories: ['ai-provider', 'screenshot'],
                defaultForCapabilities: [CODE_EDIT],
                icon: { type: 'lucide', value: 'Code' },
            },
        });

        const provider = await facade.getProviderForUser('cold-code-edit', 'user-1');

        expect(provider).toEqual(
            expect.objectContaining({
                id: 'cold-code-edit',
                isDefault: true,
                icon: { type: 'lucide', value: 'Code' },
                selectableProviderCategories: ['ai-provider', 'screenshot'],
            }),
        );
    });

    it('answers null for a cold provider its getManifest() marks supplementary', async () => {
        const { registry, facade } = build();
        registerColdPlugin(registry, {
            id: 'cold-supplementary-code-edit',
            capabilities: [CODE_EDIT],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: { supplementary: true },
        });

        await expect(
            facade.getProviderForUser('cold-supplementary-code-edit', 'user-1'),
        ).resolves.toBeNull();
    });

    it('answers null for a cold provider that cannot be imported', async () => {
        const { registry, facade } = build();
        registerColdPlugin(registry, {
            id: 'cold-broken-code-edit',
            capabilities: [CODE_EDIT],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            failing: true,
        });

        await expect(
            facade.getProviderForUser('cold-broken-code-edit', 'user-1'),
        ).resolves.toBeNull();
        expect(registry.get('cold-broken-code-edit')?.state).toBe('error');
    });
});
