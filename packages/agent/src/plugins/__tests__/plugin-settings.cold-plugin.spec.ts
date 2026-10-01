import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginSettingsService } from '../services/plugin-settings.service';
import type { PluginRegistryService } from '../services/plugin-registry.service';
import type { PluginRepository } from '../repositories/plugin.repository';
import type { UserPluginRepository } from '../repositories/user-plugin.repository';
import type { WorkPluginRepository } from '../repositories/work-plugin.repository';
import { createRegistry, registerColdPlugin, requiredSecretSchema } from './cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const ENV_KEY = 'COLD_SETTINGS_FIXTURE_API_KEY';

/**
 * Settings resolution over a plugin the registry holds as a COLD lazy proxy —
 * every plugin discovered on disk is one until something materialises it.
 * Each reader must see the plugin class's `settingsSchema` (its fields,
 * `required`, `x-envVar`, `x-secret`, `x-scope`) and `configurationMode`, not
 * the proxy's cold `{}` / `undefined`.
 */
describe('PluginSettingsService — cold lazy plugin', () => {
    let registry: PluginRegistryService;
    let pluginRepository: { findByPluginId: jest.Mock; updateSettings: jest.Mock };
    let userPluginRepository: {
        findByUserAndPlugin: jest.Mock;
        updateSettings: jest.Mock;
        create: jest.Mock;
    };
    let workPluginRepository: { findByWorkAndPlugin: jest.Mock };
    let service: PluginSettingsService;

    beforeEach(() => {
        registry = createRegistry();
        pluginRepository = {
            findByPluginId: jest
                .fn()
                .mockResolvedValue({ id: 'entity-1', settings: {}, secretSettings: {} }),
            updateSettings: jest.fn().mockResolvedValue(undefined),
        };
        userPluginRepository = {
            findByUserAndPlugin: jest.fn().mockResolvedValue(null),
            updateSettings: jest.fn().mockResolvedValue(undefined),
            create: jest.fn().mockResolvedValue(undefined),
        };
        workPluginRepository = { findByWorkAndPlugin: jest.fn().mockResolvedValue(null) };
        service = new PluginSettingsService(
            registry,
            pluginRepository as unknown as PluginRepository,
            userPluginRepository as unknown as UserPluginRepository,
            workPluginRepository as unknown as WorkPluginRepository,
            new EventEmitter2(),
        );
    });

    afterEach(() => {
        delete process.env[ENV_KEY];
    });

    it('resolves an x-envVar-bound setting from the environment while the plugin is cold', async () => {
        process.env[ENV_KEY] = 'env-secret';
        const cold = registerColdPlugin(registry, {
            id: 'cold-env',
            settingsSchema: requiredSecretSchema(ENV_KEY),
        });
        expect(cold.proxy.__isMaterialized).toBe(false);

        const resolved = await service.getResolvedSettings('cold-env', { includeSecrets: true });

        expect(resolved.apiKey).toEqual(
            expect.objectContaining({ value: 'env-secret', source: 'env' }),
        );
        expect(resolved.region).toEqual(
            expect.objectContaining({ value: 'eu', source: 'default' }),
        );
    });

    it("applies a cold plugin's admin-only configuration mode (user settings are ignored)", async () => {
        registerColdPlugin(registry, {
            id: 'cold-admin-only',
            settingsSchema: requiredSecretSchema(),
            configurationMode: 'admin-only',
        });
        pluginRepository.findByPluginId.mockResolvedValue({
            id: 'entity-1',
            settings: { region: 'us' },
            secretSettings: {},
        });
        userPluginRepository.findByUserAndPlugin.mockResolvedValue({
            settings: { region: 'ap' },
            secretSettings: {},
        });

        const settings = await service.getSettings('cold-admin-only', { userId: 'user-1' });

        expect(settings.region).toBe('us');
    });

    it('refuses user-level settings for a cold admin-only plugin', async () => {
        registerColdPlugin(registry, {
            id: 'cold-admin-only-write',
            settingsSchema: requiredSecretSchema(),
            configurationMode: 'admin-only',
        });

        await expect(
            service.updateUserSettings('cold-admin-only-write', 'user-1', { region: 'ap' }),
        ).rejects.toThrow('admin-only');
        expect(userPluginRepository.create).not.toHaveBeenCalled();
    });

    it("stores a cold plugin's x-secret field with the secrets, never with the plain settings", async () => {
        registerColdPlugin(registry, {
            id: 'cold-secret-write',
            settingsSchema: requiredSecretSchema(),
        });

        await service.updateUserSettings('cold-secret-write', 'user-1', { apiKey: 'sk-live' });

        expect(userPluginRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({
                settings: {},
                secretSettings: { apiKey: 'sk-live' },
            }),
        );
    });

    it("validates the setting scopes a cold plugin's schema declares", async () => {
        registerColdPlugin(registry, {
            id: 'cold-scope',
            settingsSchema: requiredSecretSchema(),
        });

        // `region` is `x-scope: work` — not settable at user scope.
        const result = await service.validateSettings(
            'cold-scope',
            { region: 'ap' },
            { scope: 'user' },
        );

        expect(result.valid).toBe(false);
        expect(result.errors?.join(' ')).toContain('region');
    });

    it('answers the real schema, filtered by context, for a cold plugin', async () => {
        registerColdPlugin(registry, {
            id: 'cold-context',
            settingsSchema: requiredSecretSchema(ENV_KEY),
        });

        const userSchema = await service.getSettingsSchemaForContext('cold-context', 'user');
        const fullSchema = await service.getSettingsSchema('cold-context');

        expect(Object.keys(userSchema?.properties ?? {})).toEqual(['apiKey']);
        expect(userSchema?.required).toEqual(['apiKey']);
        expect(fullSchema).toEqual(requiredSecretSchema(ENV_KEY));
    });

    it('does not import a plugin whose import already failed again on every settings read', async () => {
        const broken = registerColdPlugin(registry, {
            id: 'cold-broken-settings',
            settingsSchema: requiredSecretSchema(),
            failing: true,
        });

        await service.getSettings('cold-broken-settings', { includeSecrets: true });
        expect(broken.registered.state).toBe('error');
        const transitions = broken.registered.stateHistory.length;

        await service.getSettings('cold-broken-settings', { includeSecrets: true });
        await service.getResolvedSettings('cold-broken-settings', { includeSecrets: true });
        await service.getSettingsSchema('cold-broken-settings');

        expect(broken.loads()).toBe(1);
        expect(broken.registered.stateHistory).toHaveLength(transitions);
    });
});
