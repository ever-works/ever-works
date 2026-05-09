import { Logger } from '@nestjs/common';
import {
    BaseFacadeService,
    FacadeError,
    NoProviderError,
    ProviderNotFoundError,
} from '../base.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import type { IPlugin, PluginManifest } from '@ever-works/plugin';

const CAPABILITY = 'test-capability';

class TestFacadeService extends BaseFacadeService {
    protected readonly CAPABILITY = CAPABILITY;
    protected readonly logger = new Logger('TestFacadeService');

    // Re-expose protected helpers so we can unit-test them directly.
    public exposedIsPluginEnabled(pluginId: string, workId: string, userId: string) {
        return this.isPluginEnabled(pluginId, workId, userId);
    }

    public exposedGetResolvedSettings(
        pluginId: string,
        options: { userId: string; workId?: string },
    ) {
        return this.getResolvedSettings(pluginId, options);
    }

    public exposedGetProviderName(plugin: IPlugin) {
        return this.getProviderName(plugin);
    }

    public exposedGetSettingTyped<T>(
        settings: Record<string, unknown>,
        key: string,
        expectedType: 'string' | 'number' | 'boolean' | 'object' | 'array',
    ) {
        return this.getSettingTyped<T>(settings, key, expectedType);
    }

    public exposedGetSettingRequired<T>(
        settings: Record<string, unknown>,
        key: string,
        expectedType: 'string' | 'number' | 'boolean' | 'object' | 'array',
        pluginId?: string,
    ) {
        return this.getSettingRequired<T>(settings, key, expectedType, pluginId);
    }

    public exposedGetSettingWithDefault<T>(
        settings: Record<string, unknown>,
        key: string,
        expectedType: 'string' | 'number' | 'boolean' | 'object' | 'array',
        defaultValue: T,
    ) {
        return this.getSettingWithDefault<T>(settings, key, expectedType, defaultValue);
    }

    public exposedFindActivePluginForWork(workId: string) {
        return this.findActivePluginForWork(workId);
    }

    public exposedGetEnabledPlugins(workId: string, userId: string) {
        return this.getEnabledPlugins(workId, userId);
    }

    public exposedResolvePlugin<T extends IPlugin>(
        providerOverride?: string,
        userId?: string,
        workId?: string,
    ) {
        return this.resolvePlugin<T>(providerOverride, userId, workId);
    }
}

const buildPlugin = (id: string, overrides: Partial<IPlugin> = {}): IPlugin =>
    ({
        id,
        name: `${id}-name`,
        version: '1.0.0',
        category: 'utility',
        capabilities: [CAPABILITY],
        ...overrides,
    }) as unknown as IPlugin;

const buildManifest = (id: string, overrides: Partial<PluginManifest> = {}): PluginManifest =>
    ({
        id,
        name: `${id}-name`,
        version: '1.0.0',
        category: 'utility',
        capabilities: [CAPABILITY],
        ...overrides,
    }) as PluginManifest;

const buildRegistered = (
    id: string,
    opts: {
        state?: 'loaded' | 'unloaded' | 'error';
        defaultForCapabilities?: string[];
        plugin?: Partial<IPlugin>;
    } = {},
): RegisteredPlugin =>
    ({
        plugin: buildPlugin(id, opts.plugin ?? {}),
        manifest: buildManifest(id, {
            defaultForCapabilities: opts.defaultForCapabilities,
        }),
        state: opts.state ?? 'loaded',
        builtIn: true,
        registeredAt: 0,
        stateHistory: [],
    }) as RegisteredPlugin;

const buildRegistry = () =>
    ({
        get: jest.fn(),
        getByCapability: jest.fn(),
        isPluginEnabledForScope: jest.fn(),
    }) as unknown as jest.Mocked<PluginRegistryService>;

const buildSettingsService = () =>
    ({
        getSettings: jest.fn(),
    }) as unknown as jest.Mocked<PluginSettingsService>;

const buildWorkPluginRepository = () =>
    ({
        findActiveByCapability: jest.fn(),
    }) as unknown as jest.Mocked<WorkPluginRepository>;

describe('FacadeError hierarchy', () => {
    it('FacadeError captures operation/provider/cause and sets name="FacadeError"', () => {
        const cause = new Error('boom');
        const err = new FacadeError('top-level failure', 'doThing', 'p1', cause);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('top-level failure');
        expect(err.operation).toBe('doThing');
        expect(err.provider).toBe('p1');
        expect(err.cause).toBe(cause);
        expect(err.name).toBe('FacadeError');
    });

    it('FacadeError omits provider/cause when not supplied (both undefined)', () => {
        const err = new FacadeError('msg', 'op');
        expect(err.provider).toBeUndefined();
        expect(err.cause).toBeUndefined();
    });

    it('NoProviderError uses operation="getPlugin", capability-templated message, name="NoProviderError"', () => {
        const err = new NoProviderError('search');
        expect(err).toBeInstanceOf(FacadeError);
        expect(err.message).toBe('No search provider configured or available');
        expect(err.operation).toBe('getPlugin');
        // NoProviderError does not pass a provider id (the whole point is "no provider").
        expect(err.provider).toBeUndefined();
        expect(err.name).toBe('NoProviderError');
    });

    it('ProviderNotFoundError uses operation="getPlugin", capability-templated message + provider, name="ProviderNotFoundError"', () => {
        const err = new ProviderNotFoundError('openai', 'ai');
        expect(err).toBeInstanceOf(FacadeError);
        expect(err.message).toBe('ai provider not found: openai');
        expect(err.operation).toBe('getPlugin');
        expect(err.provider).toBe('openai');
        expect(err.name).toBe('ProviderNotFoundError');
    });
});

describe('BaseFacadeService', () => {
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;
    let workPluginRepository: jest.Mocked<WorkPluginRepository>;
    let service: TestFacadeService;

    beforeEach(() => {
        registry = buildRegistry();
        settingsService = buildSettingsService();
        workPluginRepository = buildWorkPluginRepository();
        service = new TestFacadeService(registry, settingsService, workPluginRepository);
    });

    describe('isConfigured', () => {
        it('returns true when at least one capability plugin is in state="loaded"', () => {
            registry.getByCapability.mockReturnValue([
                buildRegistered('a', { state: 'unloaded' }),
                buildRegistered('b', { state: 'loaded' }),
            ]);
            expect(service.isConfigured()).toBe(true);
            expect(registry.getByCapability).toHaveBeenCalledWith(CAPABILITY);
        });

        it('returns false when zero plugins registered for the capability', () => {
            registry.getByCapability.mockReturnValue([]);
            expect(service.isConfigured()).toBe(false);
        });

        it('returns false when plugins exist but none are loaded', () => {
            registry.getByCapability.mockReturnValue([
                buildRegistered('a', { state: 'unloaded' }),
                buildRegistered('b', { state: 'error' }),
            ]);
            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('getAvailableProviders', () => {
        it('maps every plugin to {id, name, enabled} where enabled := state==="loaded"', () => {
            registry.getByCapability.mockReturnValue([
                buildRegistered('p1', {
                    state: 'loaded',
                    plugin: { id: 'p1', name: 'P1' } as unknown as IPlugin,
                }),
                buildRegistered('p2', {
                    state: 'unloaded',
                    plugin: { id: 'p2', name: 'P2' } as unknown as IPlugin,
                }),
            ]);
            expect(service.getAvailableProviders()).toEqual([
                { id: 'p1', name: 'P1', enabled: true },
                { id: 'p2', name: 'P2', enabled: false },
            ]);
        });

        it('returns [] when no plugins registered', () => {
            registry.getByCapability.mockReturnValue([]);
            expect(service.getAvailableProviders()).toEqual([]);
        });

        it('uses providerName/sourceName fallback chain via getProviderName', () => {
            registry.getByCapability.mockReturnValue([
                buildRegistered('p1', {
                    plugin: {
                        id: 'p1',
                        name: 'plain',
                        providerName: 'override',
                    } as unknown as IPlugin,
                }),
                buildRegistered('p2', {
                    plugin: { id: 'p2', name: 'plain', sourceName: 'src' } as unknown as IPlugin,
                }),
                buildRegistered('p3', {
                    plugin: { id: 'p3', name: 'plain' } as unknown as IPlugin,
                }),
            ]);
            expect(service.getAvailableProviders().map((p) => p.name)).toEqual([
                'override',
                'src',
                'plain',
            ]);
        });
    });

    describe('getActiveProviderName', () => {
        it('returns the resolved default provider name when one is found', async () => {
            const reg = buildRegistered('p1', {
                plugin: { id: 'p1', name: 'plain', providerName: 'P1' } as unknown as IPlugin,
            });
            // Drive the workId-less branch which falls through to getEnabledPlugins.
            registry.getByCapability.mockReturnValue([reg]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            await expect(service.getActiveProviderName({ userId: 'u1' })).resolves.toBe('P1');
        });

        it('returns null when no default provider is found', async () => {
            registry.getByCapability.mockReturnValue([]);
            await expect(service.getActiveProviderName({ userId: 'u1' })).resolves.toBeNull();
        });

        it('forwards facadeOptions.workId/userId into getDefaultProvider', async () => {
            registry.getByCapability.mockReturnValue([]);
            workPluginRepository.findActiveByCapability.mockResolvedValue(null);
            await service.getActiveProviderName({ userId: 'u1', workId: 'w1' });
            expect(workPluginRepository.findActiveByCapability).toHaveBeenCalledWith(
                'w1',
                CAPABILITY,
            );
        });
    });

    describe('getDefaultProvider', () => {
        it('returns the work-active plugin when registry has it loaded AND it is enabled for scope', async () => {
            workPluginRepository.findActiveByCapability.mockResolvedValue({
                pluginId: 'p1',
            } as never);
            const reg = buildRegistered('p1', {
                plugin: { id: 'p1', name: 'plain', providerName: 'Active' } as unknown as IPlugin,
            });
            registry.get.mockReturnValue(reg);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            await expect(service.getDefaultProvider('w1', 'u1')).resolves.toEqual({
                id: 'p1',
                name: 'Active',
            });
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith('p1', 'w1', 'u1');
            // Should short-circuit before falling through to getEnabledPlugins.
            expect(registry.getByCapability).not.toHaveBeenCalled();
        });

        it('falls through to getEnabledPlugins when the work-active plugin is registered but state!=loaded', async () => {
            workPluginRepository.findActiveByCapability.mockResolvedValue({
                pluginId: 'p1',
            } as never);
            registry.get.mockReturnValue(buildRegistered('p1', { state: 'unloaded' }));
            const fallback = buildRegistered('p2', {
                plugin: { id: 'p2', name: 'plain', providerName: 'Fallback' } as unknown as IPlugin,
            });
            registry.getByCapability.mockReturnValue([fallback]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            await expect(service.getDefaultProvider('w1', 'u1')).resolves.toEqual({
                id: 'p2',
                name: 'Fallback',
            });
        });

        it('falls through to getEnabledPlugins when the work-active plugin is not enabled for scope', async () => {
            workPluginRepository.findActiveByCapability.mockResolvedValue({
                pluginId: 'p1',
            } as never);
            registry.get.mockReturnValue(buildRegistered('p1'));
            // For the work-active plugin: not enabled.
            // For getEnabledPlugins re-check: also not enabled (so the array is empty).
            registry.isPluginEnabledForScope.mockResolvedValue(false);
            registry.getByCapability.mockReturnValue([buildRegistered('p1')]);

            await expect(service.getDefaultProvider('w1', 'u1')).resolves.toBeNull();
        });

        it('falls through (no throw) when workPluginRepository.findActiveByCapability rejects', async () => {
            workPluginRepository.findActiveByCapability.mockRejectedValue(new Error('db down'));
            const fallback = buildRegistered('p2', {
                plugin: { id: 'p2', name: 'plain', providerName: 'Fallback' } as unknown as IPlugin,
            });
            registry.getByCapability.mockReturnValue([fallback]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            await expect(service.getDefaultProvider('w1', 'u1')).resolves.toEqual({
                id: 'p2',
                name: 'Fallback',
            });
        });

        it('skips the workPluginRepository branch entirely when workId is missing', async () => {
            registry.getByCapability.mockReturnValue([]);
            await expect(service.getDefaultProvider(undefined, 'u1')).resolves.toBeNull();
            expect(workPluginRepository.findActiveByCapability).not.toHaveBeenCalled();
        });

        it('skips the workPluginRepository branch when no repository is wired (DI optional)', async () => {
            const svc = new TestFacadeService(registry, settingsService, undefined);
            registry.getByCapability.mockReturnValue([]);
            await expect(svc.getDefaultProvider('w1', 'u1')).resolves.toBeNull();
            expect(workPluginRepository.findActiveByCapability).not.toHaveBeenCalled();
        });

        it('returns null when no work-active plugin exists AND no enabled plugins remain', async () => {
            workPluginRepository.findActiveByCapability.mockResolvedValue(null);
            registry.getByCapability.mockReturnValue([]);
            await expect(service.getDefaultProvider('w1', 'u1')).resolves.toBeNull();
        });
    });

    describe('getEnabledPlugins', () => {
        it('filters out plugins whose state !== "loaded" before checking enabled-for-scope', async () => {
            const a = buildRegistered('a', { state: 'unloaded' });
            const b = buildRegistered('b', { state: 'loaded' });
            registry.getByCapability.mockReturnValue([a, b]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            await expect(service.exposedGetEnabledPlugins('w1', 'u1')).resolves.toEqual([b]);
            // Loaded check happens BEFORE the enabled check, so 'a' must NOT be queried.
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledTimes(1);
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith('b', 'w1', 'u1');
        });

        it('drops plugins where isPluginEnabledForScope resolves false', async () => {
            registry.getByCapability.mockReturnValue([buildRegistered('a'), buildRegistered('b')]);
            registry.isPluginEnabledForScope
                .mockResolvedValueOnce(false) // a
                .mockResolvedValueOnce(true); // b

            const out = await service.exposedGetEnabledPlugins('w1', 'u1');
            expect(out.map((r) => r.plugin.id)).toEqual(['b']);
        });

        it('sorts plugins so manifest.defaultForCapabilities containing CAPABILITY come first', async () => {
            const a = buildRegistered('a'); // not default
            const b = buildRegistered('b', {
                defaultForCapabilities: [CAPABILITY],
            });
            const c = buildRegistered('c'); // not default
            registry.getByCapability.mockReturnValue([a, b, c]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const out = await service.exposedGetEnabledPlugins('w1', 'u1');
            expect(out.map((r) => r.plugin.id)).toEqual(['b', 'a', 'c']);
        });

        it('treats a missing manifest.defaultForCapabilities as "not default" (no crash, sort stable)', async () => {
            const a = buildRegistered('a'); // no defaultForCapabilities
            const b = buildRegistered('b', { defaultForCapabilities: ['other-cap'] });
            registry.getByCapability.mockReturnValue([a, b]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const out = await service.exposedGetEnabledPlugins('w1', 'u1');
            // Both get rank 1; stable sort keeps original order [a, b].
            expect(out.map((r) => r.plugin.id)).toEqual(['a', 'b']);
        });

        it('returns [] when no plugins registered (no isPluginEnabledForScope call)', async () => {
            registry.getByCapability.mockReturnValue([]);
            await expect(service.exposedGetEnabledPlugins('w1', 'u1')).resolves.toEqual([]);
            expect(registry.isPluginEnabledForScope).not.toHaveBeenCalled();
        });
    });

    describe('isPluginEnabled (protected, exposed)', () => {
        it('delegates verbatim to registry.isPluginEnabledForScope(pluginId, workId, userId)', async () => {
            registry.isPluginEnabledForScope.mockResolvedValue(true);
            await expect(service.exposedIsPluginEnabled('p1', 'w1', 'u1')).resolves.toBe(true);
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith('p1', 'w1', 'u1');
        });
    });

    describe('getResolvedSettings', () => {
        it('forwards {userId, workId, includeSecrets:true} to settingsService.getSettings (secrets ARE pulled at the facade boundary)', async () => {
            (settingsService.getSettings as jest.Mock).mockResolvedValue({ k: 'v' });
            await expect(
                service.exposedGetResolvedSettings('p1', { userId: 'u1', workId: 'w1' }),
            ).resolves.toEqual({ k: 'v' });
            expect(settingsService.getSettings).toHaveBeenCalledWith('p1', {
                userId: 'u1',
                workId: 'w1',
                includeSecrets: true,
            });
        });

        it('returns {} (no service call) when settingsService is undefined', async () => {
            const svc = new TestFacadeService(registry, undefined, workPluginRepository);
            await expect(svc.exposedGetResolvedSettings('p1', { userId: 'u1' })).resolves.toEqual(
                {},
            );
        });
    });

    describe('getProviderName', () => {
        it('prefers plugin.providerName when present', () => {
            const plugin = { id: 'p1', name: 'plain', providerName: 'PN' } as unknown as IPlugin;
            expect(service.exposedGetProviderName(plugin)).toBe('PN');
        });

        it('falls back to plugin.sourceName when providerName missing', () => {
            const plugin = { id: 'p1', name: 'plain', sourceName: 'SN' } as unknown as IPlugin;
            expect(service.exposedGetProviderName(plugin)).toBe('SN');
        });

        it('falls back to plugin.name when both providerName and sourceName missing', () => {
            const plugin = { id: 'p1', name: 'plain' } as unknown as IPlugin;
            expect(service.exposedGetProviderName(plugin)).toBe('plain');
        });

        it('treats empty-string providerName as falsy and falls through to sourceName', () => {
            const plugin = {
                id: 'p1',
                name: 'plain',
                providerName: '',
                sourceName: 'SN',
            } as unknown as IPlugin;
            expect(service.exposedGetProviderName(plugin)).toBe('SN');
        });
    });

    describe('getSettingTyped (protected, exposed)', () => {
        it('returns undefined when value is undefined OR null', () => {
            expect(
                service.exposedGetSettingTyped<string>(
                    { k: undefined } as Record<string, unknown>,
                    'k',
                    'string',
                ),
            ).toBeUndefined();
            expect(
                service.exposedGetSettingTyped<string>({ k: null }, 'k', 'string'),
            ).toBeUndefined();
        });

        it('returns the value when typeof matches the expected primitive type', () => {
            expect(service.exposedGetSettingTyped<string>({ k: 'hello' }, 'k', 'string')).toBe(
                'hello',
            );
            expect(service.exposedGetSettingTyped<number>({ k: 42 }, 'k', 'number')).toBe(42);
            expect(service.exposedGetSettingTyped<boolean>({ k: false }, 'k', 'boolean')).toBe(
                false,
            );
        });

        it('returns the value when expectedType="object" and value is a non-array object', () => {
            const obj = { x: 1 };
            expect(service.exposedGetSettingTyped({ k: obj }, 'k', 'object')).toBe(obj);
        });

        it('returns the value when expectedType="array" and Array.isArray(value)', () => {
            const arr = [1, 2];
            expect(service.exposedGetSettingTyped({ k: arr }, 'k', 'array')).toBe(arr);
        });

        it('treats arrays as expectedType="array" (NOT "object") — distinguishes via Array.isArray', () => {
            const arr = [1, 2];
            // expectedType=object on an array is rejected (array does not match object).
            expect(service.exposedGetSettingTyped({ k: arr }, 'k', 'object')).toBeUndefined();
            // expectedType=array on a plain object is rejected (object is not an array).
            expect(service.exposedGetSettingTyped({ k: { x: 1 } }, 'k', 'array')).toBeUndefined();
        });

        it('returns undefined and warns via this.logger when type mismatches', () => {
            const warn = jest.spyOn((service as unknown as { logger: Logger }).logger, 'warn');
            warn.mockImplementation(() => undefined);

            expect(service.exposedGetSettingTyped({ k: 42 }, 'k', 'string')).toBeUndefined();
            expect(warn).toHaveBeenCalledWith("Setting 'k' has type 'number', expected 'string'");
        });

        it('does NOT warn when value is undefined/null (no type-mismatch — just missing)', () => {
            const warn = jest.spyOn((service as unknown as { logger: Logger }).logger, 'warn');
            warn.mockImplementation(() => undefined);

            service.exposedGetSettingTyped({ k: undefined }, 'k', 'string');
            service.exposedGetSettingTyped({ k: null }, 'k', 'string');
            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe('getSettingRequired (protected, exposed)', () => {
        it('returns the typed value when present', () => {
            expect(service.exposedGetSettingRequired<string>({ k: 'v' }, 'k', 'string')).toBe('v');
        });

        it('throws "Required setting \'<key>\' is missing or has wrong type" when value is undefined', () => {
            expect(() => service.exposedGetSettingRequired<string>({}, 'k', 'string')).toThrow(
                /Required setting 'k' is missing or has wrong type/,
            );
        });

        it('throws with "for plugin \'<id>\'" qualifier when pluginId is supplied', () => {
            expect(() =>
                service.exposedGetSettingRequired<string>({}, 'apiKey', 'string', 'openai'),
            ).toThrow("Required setting 'apiKey' for plugin 'openai' is missing or has wrong type");
        });

        it('throws on type mismatch (number when string expected)', () => {
            const warn = jest.spyOn((service as unknown as { logger: Logger }).logger, 'warn');
            warn.mockImplementation(() => undefined);
            expect(() =>
                service.exposedGetSettingRequired<string>({ k: 42 }, 'k', 'string'),
            ).toThrow(/Required setting 'k'/);
            expect(warn).toHaveBeenCalled();
        });
    });

    describe('getSettingWithDefault (protected, exposed)', () => {
        it('returns the typed value when present', () => {
            expect(
                service.exposedGetSettingWithDefault<string>({ k: 'v' }, 'k', 'string', 'D'),
            ).toBe('v');
        });

        it('returns defaultValue when key missing', () => {
            expect(service.exposedGetSettingWithDefault<string>({}, 'k', 'string', 'D')).toBe('D');
        });

        it('returns defaultValue when value is null', () => {
            expect(
                service.exposedGetSettingWithDefault<string>({ k: null }, 'k', 'string', 'D'),
            ).toBe('D');
        });

        it('returns defaultValue when value type does NOT match (warns, then falls back)', () => {
            const warn = jest.spyOn((service as unknown as { logger: Logger }).logger, 'warn');
            warn.mockImplementation(() => undefined);
            expect(
                service.exposedGetSettingWithDefault<number>({ k: 'oops' }, 'k', 'number', 99),
            ).toBe(99);
            expect(warn).toHaveBeenCalled();
        });

        it('preserves a value of false when expectedType=boolean (does NOT fall back via ??)', () => {
            // Pinned: getSettingTyped returns false (a defined value), so the `??` does NOT
            // kick in. A future "use ||" refactor would silently coerce false to the default.
            expect(
                service.exposedGetSettingWithDefault<boolean>({ k: false }, 'k', 'boolean', true),
            ).toBe(false);
        });

        it('preserves a value of 0 when expectedType=number', () => {
            expect(service.exposedGetSettingWithDefault<number>({ k: 0 }, 'k', 'number', 99)).toBe(
                0,
            );
        });

        it('preserves an empty-string value when expectedType=string', () => {
            expect(
                service.exposedGetSettingWithDefault<string>({ k: '' }, 'k', 'string', 'D'),
            ).toBe('');
        });
    });

    describe('findActivePluginForWork (protected, exposed)', () => {
        it('returns the registered plugin when the active row resolves AND it is loaded', async () => {
            workPluginRepository.findActiveByCapability.mockResolvedValue({
                pluginId: 'p1',
            } as never);
            const reg = buildRegistered('p1');
            registry.get.mockReturnValue(reg);
            await expect(service.exposedFindActivePluginForWork('w1')).resolves.toBe(reg);
        });

        it('returns null when the active row points at an unregistered plugin', async () => {
            workPluginRepository.findActiveByCapability.mockResolvedValue({
                pluginId: 'p1',
            } as never);
            registry.get.mockReturnValue(undefined);
            await expect(service.exposedFindActivePluginForWork('w1')).resolves.toBeNull();
        });

        it('returns null when the active row points at a registered-but-unloaded plugin', async () => {
            workPluginRepository.findActiveByCapability.mockResolvedValue({
                pluginId: 'p1',
            } as never);
            registry.get.mockReturnValue(buildRegistered('p1', { state: 'unloaded' }));
            await expect(service.exposedFindActivePluginForWork('w1')).resolves.toBeNull();
        });

        it('returns null when the active row is null (no active plugin assigned)', async () => {
            workPluginRepository.findActiveByCapability.mockResolvedValue(null);
            await expect(service.exposedFindActivePluginForWork('w1')).resolves.toBeNull();
            expect(registry.get).not.toHaveBeenCalled();
        });

        it('swallows a workPluginRepository rejection and returns null', async () => {
            workPluginRepository.findActiveByCapability.mockRejectedValue(new Error('db down'));
            await expect(service.exposedFindActivePluginForWork('w1')).resolves.toBeNull();
        });

        it('returns null when no workPluginRepository is wired (DI optional)', async () => {
            const svc = new TestFacadeService(registry, settingsService, undefined);
            await expect(svc.exposedFindActivePluginForWork('w1')).resolves.toBeNull();
        });
    });

    describe('resolvePlugin (protected, exposed)', () => {
        describe('when providerOverride is supplied', () => {
            it('returns the registered plugin when capability matches AND state=loaded AND enabled-for-scope', async () => {
                const reg = buildRegistered('explicit', {
                    state: 'loaded',
                    plugin: {
                        id: 'explicit',
                        name: 'plain',
                        capabilities: [CAPABILITY],
                    } as unknown as IPlugin,
                });
                registry.get.mockReturnValue({
                    ...reg,
                    manifest: { ...reg.manifest, capabilities: [CAPABILITY] } as PluginManifest,
                });
                registry.isPluginEnabledForScope.mockResolvedValue(true);

                await expect(service.exposedResolvePlugin('explicit', 'u1', 'w1')).resolves.toBe(
                    reg.plugin,
                );
            });

            it('throws ProviderNotFoundError when override is unknown to the registry', async () => {
                registry.get.mockReturnValue(undefined);
                await expect(
                    service.exposedResolvePlugin('missing', 'u1', 'w1'),
                ).rejects.toBeInstanceOf(ProviderNotFoundError);
            });

            it('throws ProviderNotFoundError when override is registered but does NOT advertise the capability', async () => {
                const reg = buildRegistered('explicit');
                registry.get.mockReturnValue({
                    ...reg,
                    manifest: {
                        ...reg.manifest,
                        capabilities: ['some-other-capability'],
                    } as PluginManifest,
                });
                await expect(
                    service.exposedResolvePlugin('explicit', 'u1', 'w1'),
                ).rejects.toBeInstanceOf(ProviderNotFoundError);
            });

            it('throws ProviderNotFoundError when override is registered with the right capability but state!="loaded"', async () => {
                const reg = buildRegistered('explicit', { state: 'unloaded' });
                registry.get.mockReturnValue({
                    ...reg,
                    manifest: { ...reg.manifest, capabilities: [CAPABILITY] } as PluginManifest,
                });
                await expect(
                    service.exposedResolvePlugin('explicit', 'u1', 'w1'),
                ).rejects.toBeInstanceOf(ProviderNotFoundError);
                // Pinned: enable check is skipped when state!=loaded.
                expect(registry.isPluginEnabledForScope).not.toHaveBeenCalled();
            });

            it('throws ProviderNotFoundError when override matches everything but is NOT enabled for scope', async () => {
                const reg = buildRegistered('explicit');
                registry.get.mockReturnValue({
                    ...reg,
                    manifest: { ...reg.manifest, capabilities: [CAPABILITY] } as PluginManifest,
                });
                registry.isPluginEnabledForScope.mockResolvedValue(false);
                await expect(
                    service.exposedResolvePlugin('explicit', 'u1', 'w1'),
                ).rejects.toBeInstanceOf(ProviderNotFoundError);
            });
        });

        describe('when no providerOverride is supplied', () => {
            it('returns the work-active plugin when one resolves (skips capability scan)', async () => {
                workPluginRepository.findActiveByCapability.mockResolvedValue({
                    pluginId: 'work-active',
                } as never);
                const reg = buildRegistered('work-active');
                registry.get.mockReturnValue(reg);

                await expect(service.exposedResolvePlugin(undefined, 'u1', 'w1')).resolves.toBe(
                    reg.plugin,
                );
                // Pinned: when work-active wins, getEnabledPlugins must NOT be invoked.
                expect(registry.getByCapability).not.toHaveBeenCalled();
            });

            it('falls through to the first enabled plugin when no work-active is set', async () => {
                workPluginRepository.findActiveByCapability.mockResolvedValue(null);
                const a = buildRegistered('a');
                const b = buildRegistered('b', { defaultForCapabilities: [CAPABILITY] });
                registry.getByCapability.mockReturnValue([a, b]);
                registry.isPluginEnabledForScope.mockResolvedValue(true);

                // Sort puts b first because it has CAPABILITY in defaultForCapabilities.
                await expect(service.exposedResolvePlugin(undefined, 'u1', 'w1')).resolves.toBe(
                    b.plugin,
                );
            });

            it('throws NoProviderError when no work-active AND no enabled plugins', async () => {
                workPluginRepository.findActiveByCapability.mockResolvedValue(null);
                registry.getByCapability.mockReturnValue([]);
                await expect(
                    service.exposedResolvePlugin(undefined, 'u1', 'w1'),
                ).rejects.toBeInstanceOf(NoProviderError);
            });

            it('skips the work-active branch when workId is undefined and falls through', async () => {
                const a = buildRegistered('a');
                registry.getByCapability.mockReturnValue([a]);
                registry.isPluginEnabledForScope.mockResolvedValue(true);

                await expect(
                    service.exposedResolvePlugin(undefined, 'u1', undefined),
                ).resolves.toBe(a.plugin);
                expect(workPluginRepository.findActiveByCapability).not.toHaveBeenCalled();
            });
        });
    });

    describe('FacadesModule re-exports (sanity)', () => {
        it('exposes BaseFacadeService + the three error classes via the package barrel', async () => {
            const mod: typeof import('../index') = await import('../index');
            expect(typeof mod.BaseFacadeService).toBe('function');
            expect(typeof mod.FacadeError).toBe('function');
            expect(typeof mod.NoProviderError).toBe('function');
            expect(typeof mod.ProviderNotFoundError).toBe('function');
        });
    });
});
