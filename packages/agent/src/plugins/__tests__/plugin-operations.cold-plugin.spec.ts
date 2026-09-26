import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Repository } from 'typeorm';
import type { JsonSchema } from '@ever-works/plugin';
import { PluginOperationsService } from '../services/plugin-operations.service';
import { PluginSettingsService } from '../services/plugin-settings.service';
import { SettingsSchemaValidatorService } from '../services/settings-schema-validator.service';
import type { PluginRegistryService } from '../services/plugin-registry.service';
import type { PluginEntity } from '../entities/plugin.entity';
import type { UserPluginEntity } from '../entities/user-plugin.entity';
import type { WorkPluginEntity } from '../entities/work-plugin.entity';
import type { PluginRepository } from '../repositories/plugin.repository';
import type { UserPluginRepository } from '../repositories/user-plugin.repository';
import type { WorkPluginRepository } from '../repositories/work-plugin.repository';
import type { WorkOwnershipService } from '../../services/work-ownership.service';
import {
    createRegistry,
    loadTracker,
    registerColdPlugin,
    requiredSecretSchema,
} from './cold-plugin.fixture';

// Same isolation as plugin-operations.service.spec.ts: the facades barrel
// pulls in the whole agent graph.
jest.mock('../../facades', () => ({
    AiFacadeService: class AiFacadeService {},
}));

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/** A required secret that only the user can supply (`x-scope: user`). */
const USER_SCOPED_REQUIRED: JsonSchema = {
    type: 'object',
    properties: {
        userToken: { type: 'string', 'x-secret': true, 'x-scope': 'user' },
    },
    required: ['userToken'],
} as unknown as JsonSchema;

/**
 * `PluginOperationsService` over plugins the registry holds as COLD lazy
 * proxies. The plugin list/detail responses, the settings menu and the enable
 * / update guards all read `settingsSchema` and `configurationMode`; each must
 * see the plugin class's values, not the cold proxy's `{}` / `undefined`.
 */
describe('PluginOperationsService — cold lazy plugins', () => {
    let registry: PluginRegistryService;
    let service: PluginOperationsService;
    let userPluginRepository: {
        find: jest.Mock;
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };
    let workPluginRepository: {
        find: jest.Mock;
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };

    beforeEach(() => {
        registry = createRegistry();
        const pluginRepository = {
            findOne: jest.fn(async ({ where }: { where: { pluginId: string } }) => ({
                id: `entity-${where.pluginId}`,
                pluginId: where.pluginId,
            })),
        };
        userPluginRepository = {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((row: Record<string, unknown>) => row),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        workPluginRepository = {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((row: Record<string, unknown>) => row),
            save: jest.fn(async (row: Record<string, unknown>) => row),
        };
        const settingsService = new PluginSettingsService(
            registry,
            { findByPluginId: jest.fn().mockResolvedValue(null) } as unknown as PluginRepository,
            {
                findByUserAndPlugin: jest.fn().mockResolvedValue(null),
            } as unknown as UserPluginRepository,
            {
                findByWorkAndPlugin: jest.fn().mockResolvedValue(null),
            } as unknown as WorkPluginRepository,
            new EventEmitter2(),
        );
        service = new PluginOperationsService(
            pluginRepository as unknown as Repository<PluginEntity>,
            userPluginRepository as unknown as Repository<UserPluginEntity>,
            workPluginRepository as unknown as Repository<WorkPluginEntity>,
            registry,
            new SettingsSchemaValidatorService(),
            settingsService,
            {} as never,
            new EventEmitter2(),
            undefined,
            {
                ensureCanEdit: jest.fn().mockResolvedValue(undefined),
                ensureCanView: jest.fn().mockResolvedValue(undefined),
            } as unknown as WorkOwnershipService,
        );
    });

    it("answers a cold plugin's real settings schema and configuration mode", async () => {
        registerColdPlugin(registry, {
            id: 'cold-detail',
            settingsSchema: requiredSecretSchema(),
            configurationMode: 'admin-only',
        });

        const response = await service.getPlugin('cold-detail', 'user-1');

        expect(response.configurationMode).toBe('admin-only');
        expect(Object.keys(response.settingsSchema?.properties ?? {})).toEqual([
            'apiKey',
            'region',
        ]);
        expect(response.settingsSchema?.required).toEqual(['apiKey']);
    });

    it('refuses user settings when enabling a cold admin-only plugin', async () => {
        registerColdPlugin(registry, {
            id: 'cold-admin-enable',
            settingsSchema: requiredSecretSchema(),
            configurationMode: 'admin-only',
        });

        await expect(
            service.enablePluginForUser('cold-admin-enable', 'user-1', { region: 'ap' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(userPluginRepository.save).not.toHaveBeenCalled();
    });

    it("enforces a cold plugin's user-level required settings before enabling it for a Work", async () => {
        registerColdPlugin(registry, {
            id: 'cold-work-enable',
            settingsSchema: USER_SCOPED_REQUIRED,
            manifest: { autoEnable: true },
        });

        await expect(
            service.enablePluginForWork('work-1', 'cold-work-enable', 'user-1'),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    // The list / menu cases below register their plugins as builtIns (pin
    // changed, F7 of the second review of 60916d328: they were non-builtIn).
    // A list loads only the builtIns — the plugins the boot before lazy
    // builtIns loaded — and every real plugin these cases model (settings,
    // visibility or uiHints set in the class only) is one. A non-builtIn stays
    // cold on a list: see "lists never load" below.

    it('lists a cold plugin with user settings in the settings menu, flagged as needing setup', async () => {
        registerColdPlugin(registry, {
            id: 'cold-menu',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });
        registerColdPlugin(registry, {
            id: 'cold-menu-admin-only',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
            configurationMode: 'admin-only',
            manifest: { autoEnable: true },
        });

        const menu = await service.getPluginsForSettingsMenu('user-1');

        const listed = menu.categories.flatMap((category) => category.plugins);
        expect(listed.map((plugin) => plugin.pluginId)).toEqual(['cold-menu']);
        expect(listed[0].hasRequiredSettings).toBe(true);
    });

    // The manifest fields below come from the class's getManifest() only
    // (package.json leaves them unset), as for many builtIns.

    it('leaves a cold plugin whose getManifest() declares it hidden out of the plugin list', async () => {
        registerColdPlugin(registry, {
            id: 'cold-visible',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
        });
        registerColdPlugin(registry, {
            id: 'cold-hidden',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
            runtimeManifest: { visibility: 'hidden' },
        });

        const list = await service.listPlugins('user-1');

        expect(list.plugins.map((plugin) => plugin.pluginId)).toEqual(['cold-visible']);
    });

    it("leaves a cold user-only plugin out of a Work's plugin list", async () => {
        registerColdPlugin(registry, {
            id: 'cold-work-visible',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
        });
        registerColdPlugin(registry, {
            id: 'cold-user-only',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
            runtimeManifest: { visibility: 'user-only' },
        });

        const list = await service.listWorkPlugins('work-1', 'user-1');

        expect(list.plugins.map((plugin) => plugin.pluginId)).toEqual(['cold-work-visible']);
    });

    it('refuses to make a cold supplementary plugin the active provider of a Work', async () => {
        registerColdPlugin(registry, {
            id: 'cold-supplementary',
            capabilities: ['content-extractor'],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: { supplementary: true },
        });

        await expect(
            service.setActiveCapability(
                'work-1',
                'cold-supplementary',
                'user-1',
                'content-extractor',
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    // The other path that names a Work's provider: enabling a plugin for the
    // Work WITH `activeCapability`. It used to accept a supplementary plugin
    // and record the capability on its binding, which the Work's provider map
    // (listWorkPlugins) never honours — flow-plugin-content-extractor got 200
    // for notion-extractor, then no provider. A supplementary extractor runs
    // for its URLs on top of the Work's provider, never as it.
    it('refuses to bind a cold supplementary plugin as the active provider when enabling it for a Work', async () => {
        const cold = registerColdPlugin(registry, {
            id: 'cold-supplementary-enable',
            capabilities: ['content-extractor'],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: { supplementary: true },
        });

        const error = await service
            .enablePluginForWork('work-1', 'cold-supplementary-enable', 'user-1', {
                activeCapability: 'content-extractor',
            })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message).toBe(
            'Plugin "cold-supplementary-enable" is a supplementary plugin and cannot be set as an active capability provider',
        );
        expect(cold.loads()).toBe(1);
        expect(workPluginRepository.save).not.toHaveBeenCalled();
    });

    it('still enables a cold supplementary plugin for a Work when no active capability is asked for', async () => {
        registerColdPlugin(registry, {
            id: 'cold-supplementary-plain-enable',
            capabilities: ['content-extractor'],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: { supplementary: true },
        });

        await service.enablePluginForWork('work-1', 'cold-supplementary-plain-enable', 'user-1');

        expect(workPluginRepository.save).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: 'work-1',
                pluginId: 'cold-supplementary-plain-enable',
                enabled: true,
                activeCapabilities: [],
            }),
        );
    });

    it('reports the onboarding connection status of a cold plugin', async () => {
        registerColdPlugin(registry, {
            id: 'cold-onboarding',
            settingsSchema: requiredSecretSchema(),
            runtimeManifest: { uiHints: { includeInOnboarding: true } },
            members: {
                validateConnection: async () => ({ success: false, message: 'API key missing' }),
            },
        });

        const status = await service.getPluginConnectionStatus('cold-onboarding', 'user-1');

        expect(status).toEqual({ connected: false, scope: 'user', message: 'API key missing' });
    });

    it('does not import a plugin whose import already failed again on each plugin list', async () => {
        registerColdPlugin(registry, {
            id: 'cold-listed-ok',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
        });
        const broken = registerColdPlugin(registry, {
            id: 'cold-listed-broken',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
            failing: true,
        });

        await service.listPlugins('user-1');
        expect(broken.registered.state).toBe('error');
        await service.listPlugins('user-1');
        await service.listWorkPlugins('work-1', 'user-1');

        expect(broken.loads()).toBe(1);
    });

    it('refuses as voice default a cold AI provider whose onLoad fails on this first use (F6)', async () => {
        const cold = registerColdPlugin(registry, {
            id: 'cold-voice-onload-fails',
            capabilities: ['ai-provider'],
            settingsSchema: requiredSecretSchema(),
            onLoadFails: true,
            members: { transcribe: async () => ({ text: '' }) },
        });

        await expect(
            service.setGlobalVoiceDefault('user-1', 'cold-voice-onload-fails'),
        ).rejects.toThrow(/cannot be used for voice transcription.*error state/);
        expect(cold.registered.state).toBe('error');
        expect(userPluginRepository.save).not.toHaveBeenCalled();
    });

    it('leaves a builtIn out of the settings menu when its getManifest() hides it (F5)', async () => {
        registerColdPlugin(registry, {
            id: 'cold-menu-shown',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });
        registerColdPlugin(registry, {
            id: 'cold-menu-hidden-at-runtime',
            builtIn: true,
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: { visibility: 'hidden' },
        });

        const menu = await service.getPluginsForSettingsMenu('user-1');

        const listed = menu.categories.flatMap((category) => category.plugins);
        expect(listed.map((plugin) => plugin.pluginId)).toEqual(['cold-menu-shown']);
    });

    /**
     * F7 — the lists and the settings menu load plugins only to show what their
     * class adds; before lazy builtIns (60916d328) they loaded nothing, and
     * every builtIn was loaded at boot. So they load the builtIns, a bounded
     * number at a time, and never a non-builtIn nobody uses: that one keeps
     * its package.json manifest and the cold proxy's `{}` schema, as then.
     */
    describe('lists never load a cold plugin that is not builtIn', () => {
        // Pin changed (review of the F7 fix): this plugin was `autoEnable`,
        // i.e. enabled for the user, and the menu assertion read "its cold
        // schema has no user settings, so the menu leaves it out" — the menu
        // dropping a plugin the user has enabled, which is the defect. A list
        // loads the plugins its viewer has enabled whatever their builtIn flag
        // (see "lists load a non-builtIn the user or the Work has enabled"
        // below); a non-builtIn nobody has enabled stays cold, as here.
        it('lists a cold non-builtIn nobody has enabled by its package.json manifest without importing it', async () => {
            const cold = registerColdPlugin(registry, {
                id: 'cold-third-party',
                capabilities: ['ai-provider'],
                settingsSchema: requiredSecretSchema(),
                runtimeManifest: { uiHints: { includeInOnboarding: true } },
            });

            const list = await service.listPlugins('user-1');
            const menu = await service.getPluginsForSettingsMenu('user-1');
            const workList = await service.listWorkPlugins('work-1', 'user-1');

            expect(cold.loads()).toBe(0);
            expect(cold.proxy.__isMaterialized).toBe(false);
            expect(list.plugins.map((plugin) => plugin.pluginId)).toEqual(['cold-third-party']);
            expect(workList.plugins.map((plugin) => plugin.pluginId)).toEqual(['cold-third-party']);
            // Not enabled for the user, so the menu leaves it out.
            expect(menu.categories.flatMap((category) => category.plugins)).toEqual([]);
        });

        it('still loads a cold non-builtIn for its own detail page', async () => {
            const cold = registerColdPlugin(registry, {
                id: 'cold-third-party-detail',
                settingsSchema: requiredSecretSchema(),
            });

            const response = await service.getPlugin('cold-third-party-detail', 'user-1');

            expect(cold.loads()).toBe(1);
            expect(response.settingsSchema?.required).toEqual(['apiKey']);
        });
    });

    /**
     * Review of the F7 fix: loading only the builtIns is right for a CATALOG
     * (every visible plugin), not for the plugins its viewer USES. The settings
     * menu and the settings page list the plugins the user has enabled, and a
     * Work's list decides its capability providers from the plugins the Work
     * has enabled: a non-builtIn among those (notion-extractor, apify,
     * screenshotone) is loaded, as the detail page loads it.
     */
    describe('lists load a non-builtIn the user or the Work has enabled', () => {
        function enabledForUser(...pluginIds: string[]) {
            userPluginRepository.find.mockResolvedValue(
                pluginIds.map((pluginId) => ({
                    id: `user-plugin-${pluginId}`,
                    userId: 'user-1',
                    pluginId,
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                })),
            );
        }

        it('shows an enabled non-builtIn with user settings in the settings menu, needing setup', async () => {
            const cold = registerColdPlugin(registry, {
                id: 'enabled-third-party-menu',
                settingsSchema: requiredSecretSchema(),
            });
            enabledForUser('enabled-third-party-menu');

            const menu = await service.getPluginsForSettingsMenu('user-1');

            const listed = menu.categories.flatMap((category) => category.plugins);
            expect(listed.map((plugin) => plugin.pluginId)).toEqual(['enabled-third-party-menu']);
            expect(listed[0].hasRequiredSettings).toBe(true);
            expect(cold.loads()).toBe(1);
        });

        it("answers an enabled non-builtIn's real schema on the settings page and the plugin list", async () => {
            registerColdPlugin(registry, {
                id: 'enabled-third-party-page',
                settingsSchema: requiredSecretSchema(),
            });
            const untouched = registerColdPlugin(registry, {
                id: 'not-enabled-third-party',
                settingsSchema: requiredSecretSchema(),
            });
            enabledForUser('enabled-third-party-page');

            // The settings page: the plugins of one category the user has enabled.
            const page = await service.listPlugins('user-1', 'utility');
            const list = await service.listPlugins('user-1');

            expect(page.plugins.map((plugin) => plugin.pluginId)).toEqual([
                'enabled-third-party-page',
            ]);
            expect(page.plugins[0].settingsSchema?.required).toEqual(['apiKey']);
            const row = list.plugins.find(
                (plugin) => plugin.pluginId === 'enabled-third-party-page',
            );
            expect(row?.settingsSchema?.required).toEqual(['apiKey']);
            // The catalog still leaves a non-builtIn nobody enabled cold.
            expect(untouched.loads()).toBe(0);
        });

        it("keeps a Work-enabled non-builtIn that getManifest() marks supplementary out of the Work's providers", async () => {
            registerColdPlugin(registry, {
                id: 'work-extractor',
                capabilities: ['content-extractor'],
                settingsSchema: requiredSecretSchema(),
            });
            const specialist = registerColdPlugin(registry, {
                id: 'work-extractor-specialist',
                capabilities: ['content-extractor'],
                settingsSchema: requiredSecretSchema(),
                // notion-extractor: `supplementary` only in its class.
                runtimeManifest: { supplementary: true },
            });
            // The specialist's row comes last: without its class's manifest it
            // would be recorded as the Work's content extractor.
            workPluginRepository.find.mockResolvedValue(
                ['work-extractor', 'work-extractor-specialist'].map((pluginId) => ({
                    id: `work-plugin-${pluginId}`,
                    workId: 'work-1',
                    pluginId,
                    enabled: true,
                    activeCapabilities: ['content-extractor'],
                    settings: {},
                    secretSettings: {},
                })),
            );

            const workList = await service.listWorkPlugins('work-1', 'user-1');

            expect(specialist.loads()).toBe(1);
            expect(workList.capabilityProviders).toEqual({ 'content-extractor': 'work-extractor' });
        });
    });

    describe('lists load a bounded number of plugins at a time', () => {
        const saved = process.env.PLUGIN_LOAD_CONCURRENCY;
        afterEach(() => {
            if (saved === undefined) delete process.env.PLUGIN_LOAD_CONCURRENCY;
            else process.env.PLUGIN_LOAD_CONCURRENCY = saved;
        });

        function registerBuiltIns(count: number) {
            const tracker = loadTracker();
            const plugins = Array.from({ length: count }, (_, index) =>
                registerColdPlugin(registry, {
                    id: `cold-builtin-${String(index).padStart(2, '0')}`,
                    builtIn: true,
                    settingsSchema: requiredSecretSchema(),
                    manifest: { autoEnable: true },
                    loadTracker: tracker,
                }),
            );
            return { tracker, plugins };
        }

        it('never has more than 6 first loads in flight for one plugin list', async () => {
            delete process.env.PLUGIN_LOAD_CONCURRENCY;
            const { tracker, plugins } = registerBuiltIns(14);

            const list = await service.listPlugins('user-1');

            expect(list.plugins).toHaveLength(14);
            expect(plugins.every((plugin) => plugin.loads() === 1)).toBe(true);
            expect(tracker.peak).toBeGreaterThan(1);
            expect(tracker.peak).toBeLessThanOrEqual(6);
        });

        it('takes its bound from PLUGIN_LOAD_CONCURRENCY (the settings menu)', async () => {
            process.env.PLUGIN_LOAD_CONCURRENCY = '2';
            const { tracker } = registerBuiltIns(9);

            await service.getPluginsForSettingsMenu('user-1');
            expect(tracker.peak).toBe(2);
        });

        it('bounds the Work plugin list the same way', async () => {
            process.env.PLUGIN_LOAD_CONCURRENCY = '3';
            const { tracker } = registerBuiltIns(10);

            await service.listWorkPlugins('work-1', 'user-1');
            expect(tracker.peak).toBe(3);
        });
    });
});
