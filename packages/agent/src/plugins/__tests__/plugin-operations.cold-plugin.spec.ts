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
import { createRegistry, registerColdPlugin, requiredSecretSchema } from './cold-plugin.fixture';

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
        const workPluginRepository = {
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

    it('lists a cold plugin with user settings in the settings menu, flagged as needing setup', async () => {
        registerColdPlugin(registry, {
            id: 'cold-menu',
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });
        registerColdPlugin(registry, {
            id: 'cold-menu-admin-only',
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
            settingsSchema: requiredSecretSchema(),
        });
        registerColdPlugin(registry, {
            id: 'cold-hidden',
            settingsSchema: requiredSecretSchema(),
            runtimeManifest: { visibility: 'hidden' },
        });

        const list = await service.listPlugins('user-1');

        expect(list.plugins.map((plugin) => plugin.pluginId)).toEqual(['cold-visible']);
    });

    it("leaves a cold user-only plugin out of a Work's plugin list", async () => {
        registerColdPlugin(registry, {
            id: 'cold-work-visible',
            settingsSchema: requiredSecretSchema(),
        });
        registerColdPlugin(registry, {
            id: 'cold-user-only',
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
            settingsSchema: requiredSecretSchema(),
        });
        const broken = registerColdPlugin(registry, {
            id: 'cold-listed-broken',
            settingsSchema: requiredSecretSchema(),
            failing: true,
        });

        await service.listPlugins('user-1');
        expect(broken.registered.state).toBe('error');
        await service.listPlugins('user-1');
        await service.listWorkPlugins('work-1', 'user-1');

        expect(broken.loads()).toBe(1);
    });
});
