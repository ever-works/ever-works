jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginOperationsService: class {},
    PluginRegistryService: class {},
    PluginSettingsService: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    GitFacadeService: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        PLUGIN_ENABLED: 'plugin_enabled',
        PLUGIN_DISABLED: 'plugin_disabled',
        PLUGIN_CONFIGURED: 'plugin_configured',
    },
    ActivityStatus: { COMPLETED: 'COMPLETED' },
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { PluginsController } from './plugins.controller';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import type { PluginOperationsService } from '@ever-works/agent/plugins';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import type { PluginValidationService } from './plugin-validation.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('PluginsController', () => {
    let pluginsService: {
        listPlugins: jest.Mock;
        getPluginsForSettingsMenu: jest.Mock;
        listPluginModels: jest.Mock;
        getPlugin: jest.Mock;
        enablePluginForUser: jest.Mock;
        disablePluginForUser: jest.Mock;
        updateUserPluginSettings: jest.Mock;
        setGlobalPipelineDefault: jest.Mock;
        listWorkPlugins: jest.Mock;
        enablePluginForWork: jest.Mock;
        disablePluginForWork: jest.Mock;
        updateWorkPluginSettings: jest.Mock;
        setActiveCapability: jest.Mock;
    };
    let ownershipService: { ensureCanView: jest.Mock; ensureCanEdit: jest.Mock };
    let pluginValidationService: {
        tryValidateConnection: jest.Mock;
        validateUserPluginConnection: jest.Mock;
    };
    let activityLogService: { log: jest.Mock };
    let controller: PluginsController;
    const auth: AuthenticatedUser = { userId: 'user-1' } as any;

    beforeEach(() => {
        pluginsService = {
            listPlugins: jest.fn(),
            getPluginsForSettingsMenu: jest.fn(),
            listPluginModels: jest.fn(),
            getPlugin: jest.fn(),
            enablePluginForUser: jest.fn(),
            disablePluginForUser: jest.fn(),
            updateUserPluginSettings: jest.fn(),
            setGlobalPipelineDefault: jest.fn(),
            listWorkPlugins: jest.fn(),
            enablePluginForWork: jest.fn(),
            disablePluginForWork: jest.fn(),
            updateWorkPluginSettings: jest.fn(),
            setActiveCapability: jest.fn(),
        };
        ownershipService = {
            ensureCanView: jest.fn().mockResolvedValue(undefined),
            ensureCanEdit: jest.fn().mockResolvedValue(undefined),
        };
        pluginValidationService = {
            tryValidateConnection: jest.fn(),
            validateUserPluginConnection: jest.fn(),
        };
        activityLogService = { log: jest.fn().mockResolvedValue(undefined) };
        controller = new PluginsController(
            pluginsService as unknown as PluginOperationsService,
            ownershipService as unknown as WorkOwnershipService,
            pluginValidationService as unknown as PluginValidationService,
            activityLogService as unknown as ActivityLogService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ============================================
    // Plugin Listing
    // ============================================

    describe('listPlugins', () => {
        it('forwards (userId, category) to listPlugins', async () => {
            pluginsService.listPlugins.mockResolvedValue({ plugins: [{ id: 'p1' }] });

            const result = await controller.listPlugins(auth, 'ai-provider');

            expect(pluginsService.listPlugins).toHaveBeenCalledWith('user-1', 'ai-provider');
            expect(result).toEqual({ plugins: [{ id: 'p1' }] });
        });

        it('forwards undefined category when no query param', async () => {
            pluginsService.listPlugins.mockResolvedValue({ plugins: [] });

            await controller.listPlugins(auth);

            expect(pluginsService.listPlugins).toHaveBeenCalledWith('user-1', undefined);
        });
    });

    describe('getPluginsForSettingsMenu', () => {
        it('forwards userId and returns service result', async () => {
            pluginsService.getPluginsForSettingsMenu.mockResolvedValue({ categories: [] });

            const result = await controller.getPluginsForSettingsMenu(auth);

            expect(pluginsService.getPluginsForSettingsMenu).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ categories: [] });
        });
    });

    describe('listPluginModels', () => {
        it('forwards (pluginId, userId) and returns models array', async () => {
            pluginsService.listPluginModels.mockResolvedValue([
                { id: 'gpt-5', name: 'GPT-5' },
            ]);

            const result = await controller.listPluginModels(auth, 'openai');

            expect(pluginsService.listPluginModels).toHaveBeenCalledWith('openai', 'user-1');
            expect(result).toEqual([{ id: 'gpt-5', name: 'GPT-5' }]);
        });
    });

    describe('getPlugin', () => {
        it('forwards (pluginId, userId)', async () => {
            pluginsService.getPlugin.mockResolvedValue({ id: 'openai' });

            const result = await controller.getPlugin(auth, 'openai');

            expect(pluginsService.getPlugin).toHaveBeenCalledWith('openai', 'user-1');
            expect(result).toEqual({ id: 'openai' });
        });
    });

    // ============================================
    // User Plugin Management
    // ============================================

    describe('enablePlugin', () => {
        it('forwards positional args (pluginId, userId, settings, secretSettings, autoEnableForWorks) and emits PLUGIN_ENABLED log', async () => {
            pluginsService.enablePluginForUser.mockResolvedValue({ id: 'openai', enabled: true });
            const dto: any = {
                settings: { region: 'us' },
                secretSettings: { apiKey: 'sk' },
                autoEnableForWorks: true,
            };

            const result = await controller.enablePlugin(auth, 'openai', dto);

            expect(pluginsService.enablePluginForUser).toHaveBeenCalledWith(
                'openai',
                'user-1',
                { region: 'us' },
                { apiKey: 'sk' },
                true,
            );
            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'user-1',
                actionType: ActivityActionType.PLUGIN_ENABLED,
                action: 'plugin.enabled',
                status: ActivityStatus.COMPLETED,
                summary: 'Enabled plugin: openai',
            });
            expect(result).toEqual({ id: 'openai', enabled: true });
        });

        it('forwards undefined optional fields when omitted', async () => {
            pluginsService.enablePluginForUser.mockResolvedValue({});
            const dto: any = {};

            await controller.enablePlugin(auth, 'p', dto);

            expect(pluginsService.enablePluginForUser).toHaveBeenCalledWith(
                'p',
                'user-1',
                undefined,
                undefined,
                undefined,
            );
        });

        it('swallows activity-log rejection (fire-and-forget) but still returns service result', async () => {
            pluginsService.enablePluginForUser.mockResolvedValue({ id: 'p' });
            activityLogService.log.mockRejectedValue(new Error('log down'));

            await expect(controller.enablePlugin(auth, 'p', {} as any)).resolves.toEqual({
                id: 'p',
            });
            // microtask flush
            await new Promise((r) => setImmediate(r));
        });

        it('does not emit log when service rejects', async () => {
            pluginsService.enablePluginForUser.mockRejectedValue(new Error('boom'));

            await expect(controller.enablePlugin(auth, 'p', {} as any)).rejects.toThrow('boom');
            expect(activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('disablePlugin', () => {
        it('forwards (pluginId, userId) and emits PLUGIN_DISABLED log', async () => {
            pluginsService.disablePluginForUser.mockResolvedValue({ id: 'p', enabled: false });

            const result = await controller.disablePlugin(auth, 'p');

            expect(pluginsService.disablePluginForUser).toHaveBeenCalledWith('p', 'user-1');
            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'user-1',
                actionType: ActivityActionType.PLUGIN_DISABLED,
                action: 'plugin.disabled',
                status: ActivityStatus.COMPLETED,
                summary: 'Disabled plugin: p',
            });
            expect(result).toEqual({ id: 'p', enabled: false });
        });

        it('does not emit log on service rejection', async () => {
            pluginsService.disablePluginForUser.mockRejectedValue(new Error('x'));

            await expect(controller.disablePlugin(auth, 'p')).rejects.toThrow('x');
            expect(activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('updatePluginSettings', () => {
        it('forwards (pluginId, userId, settings, secretSettings, metadata), runs tryValidateConnection without workId, emits PLUGIN_CONFIGURED log, returns merged {result, validation}', async () => {
            pluginsService.updateUserPluginSettings.mockResolvedValue({ id: 'p', settings: {} });
            pluginValidationService.tryValidateConnection.mockResolvedValue({
                success: true,
                message: 'ok',
            });
            const dto: any = {
                settings: { a: 1 },
                secretSettings: { b: 2 },
                metadata: { tag: 't' },
            };

            const result = await controller.updatePluginSettings(auth, 'p', dto);

            expect(pluginsService.updateUserPluginSettings).toHaveBeenCalledWith(
                'p',
                'user-1',
                { a: 1 },
                { b: 2 },
                { tag: 't' },
            );
            expect(pluginValidationService.tryValidateConnection).toHaveBeenCalledWith(
                'p',
                'user-1',
            );
            // Important: NO workId passed for the user-level update path
            expect(pluginValidationService.tryValidateConnection.mock.calls[0]).toHaveLength(2);
            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'user-1',
                actionType: ActivityActionType.PLUGIN_CONFIGURED,
                action: 'plugin.configured',
                status: ActivityStatus.COMPLETED,
                summary: 'Updated plugin settings: p',
            });
            expect(result).toEqual({
                id: 'p',
                settings: {},
                validation: { success: true, message: 'ok' },
            });
        });

        it('returns {validation: null} when validation hook returns null and still emits log', async () => {
            pluginsService.updateUserPluginSettings.mockResolvedValue({ id: 'p' });
            pluginValidationService.tryValidateConnection.mockResolvedValue(null);

            const result = await controller.updatePluginSettings(auth, 'p', {} as any);

            expect(result).toEqual({ id: 'p', validation: null });
            expect(activityLogService.log).toHaveBeenCalled();
        });

        it('does not emit log when service rejects (and never calls tryValidateConnection)', async () => {
            pluginsService.updateUserPluginSettings.mockRejectedValue(new Error('boom'));

            await expect(
                controller.updatePluginSettings(auth, 'p', {} as any),
            ).rejects.toThrow('boom');
            expect(pluginValidationService.tryValidateConnection).not.toHaveBeenCalled();
            expect(activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('setGlobalPipelineDefault', () => {
        it('forwards (userId, pluginId, enforce) with explicit pluginId and enforce=true', async () => {
            pluginsService.setGlobalPipelineDefault.mockResolvedValue(undefined);

            await controller.setGlobalPipelineDefault(auth, {
                pluginId: 'standard-pipeline',
                enforce: true,
            } as any);

            expect(pluginsService.setGlobalPipelineDefault).toHaveBeenCalledWith(
                'user-1',
                'standard-pipeline',
                true,
            );
        });

        it('coerces missing pluginId to null and forwards undefined enforce', async () => {
            pluginsService.setGlobalPipelineDefault.mockResolvedValue(undefined);

            await controller.setGlobalPipelineDefault(auth, {} as any);

            expect(pluginsService.setGlobalPipelineDefault).toHaveBeenCalledWith(
                'user-1',
                null,
                undefined,
            );
        });

        it('forwards null pluginId verbatim (clear default)', async () => {
            pluginsService.setGlobalPipelineDefault.mockResolvedValue(undefined);

            await controller.setGlobalPipelineDefault(auth, {
                pluginId: null,
                enforce: false,
            } as any);

            expect(pluginsService.setGlobalPipelineDefault).toHaveBeenCalledWith(
                'user-1',
                null,
                false,
            );
        });
    });

    describe('validatePluginConnection', () => {
        it('forwards (pluginId, userId) to validateUserPluginConnection and returns its result', async () => {
            pluginValidationService.validateUserPluginConnection.mockResolvedValue({
                success: true,
                message: 'ok',
            });

            const result = await controller.validatePluginConnection(auth, 'p');

            expect(
                pluginValidationService.validateUserPluginConnection,
            ).toHaveBeenCalledWith('p', 'user-1');
            expect(result).toEqual({ success: true, message: 'ok' });
        });

        it('propagates errors from validateUserPluginConnection', async () => {
            pluginValidationService.validateUserPluginConnection.mockRejectedValue(
                new Error('not loaded'),
            );

            await expect(
                controller.validatePluginConnection(auth, 'p'),
            ).rejects.toThrow('not loaded');
        });
    });

    // ============================================
    // Work Plugin Management
    // ============================================

    describe('listWorkPlugins', () => {
        it('runs ensureCanView(workId, userId) BEFORE listWorkPlugins and forwards (workId, userId)', async () => {
            const order: string[] = [];
            ownershipService.ensureCanView.mockImplementation(async () => {
                order.push('view');
            });
            pluginsService.listWorkPlugins.mockImplementation(async () => {
                order.push('list');
                return { plugins: [] };
            });

            const result = await controller.listWorkPlugins(auth, 'w-1');

            expect(order).toEqual(['view', 'list']);
            expect(ownershipService.ensureCanView).toHaveBeenCalledWith('w-1', 'user-1');
            expect(pluginsService.listWorkPlugins).toHaveBeenCalledWith('w-1', 'user-1');
            expect(result).toEqual({ plugins: [] });
        });

        it('skips listWorkPlugins when ensureCanView rejects', async () => {
            ownershipService.ensureCanView.mockRejectedValue(new Error('forbidden'));

            await expect(controller.listWorkPlugins(auth, 'w-1')).rejects.toThrow('forbidden');
            expect(pluginsService.listWorkPlugins).not.toHaveBeenCalled();
        });
    });

    describe('enableWorkPlugin', () => {
        it('runs ensureCanEdit BEFORE enablePluginForWork, forwards object payload, emits work.plugin_enabled log', async () => {
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => order.push('edit'));
            pluginsService.enablePluginForWork.mockImplementation(async () => {
                order.push('enable');
                return { id: 'p', workId: 'w-1' };
            });
            const dto: any = {
                settings: { x: 1 },
                activeCapability: 'search',
                priority: 5,
            };

            const result = await controller.enableWorkPlugin(auth, 'w-1', 'p', dto);

            expect(order).toEqual(['edit', 'enable']);
            expect(ownershipService.ensureCanEdit).toHaveBeenCalledWith('w-1', 'user-1');
            expect(pluginsService.enablePluginForWork).toHaveBeenCalledWith(
                'w-1',
                'p',
                'user-1',
                { settings: { x: 1 }, activeCapability: 'search', priority: 5 },
            );
            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'user-1',
                workId: 'w-1',
                actionType: ActivityActionType.PLUGIN_ENABLED,
                action: 'work.plugin_enabled',
                status: ActivityStatus.COMPLETED,
                summary: 'Enabled plugin p for work',
            });
            expect(result).toEqual({ id: 'p', workId: 'w-1' });
        });

        it('forwards undefined for omitted optional dto fields', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue(undefined);
            pluginsService.enablePluginForWork.mockResolvedValue({});

            await controller.enableWorkPlugin(auth, 'w-1', 'p', {} as any);

            expect(pluginsService.enablePluginForWork).toHaveBeenCalledWith(
                'w-1',
                'p',
                'user-1',
                { settings: undefined, activeCapability: undefined, priority: undefined },
            );
        });

        it('does not emit log when ensureCanEdit rejects', async () => {
            ownershipService.ensureCanEdit.mockRejectedValue(new Error('nope'));

            await expect(
                controller.enableWorkPlugin(auth, 'w-1', 'p', {} as any),
            ).rejects.toThrow('nope');
            expect(pluginsService.enablePluginForWork).not.toHaveBeenCalled();
            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('does not emit log when enablePluginForWork rejects', async () => {
            pluginsService.enablePluginForWork.mockRejectedValue(new Error('boom'));

            await expect(
                controller.enableWorkPlugin(auth, 'w-1', 'p', {} as any),
            ).rejects.toThrow('boom');
            expect(activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('disableWorkPlugin', () => {
        it('runs ensureCanEdit BEFORE disablePluginForWork, emits work.plugin_disabled log', async () => {
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => order.push('edit'));
            pluginsService.disablePluginForWork.mockImplementation(async () => {
                order.push('disable');
                return { id: 'p' };
            });

            const result = await controller.disableWorkPlugin(auth, 'w-1', 'p');

            expect(order).toEqual(['edit', 'disable']);
            expect(pluginsService.disablePluginForWork).toHaveBeenCalledWith(
                'w-1',
                'p',
                'user-1',
            );
            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'user-1',
                workId: 'w-1',
                actionType: ActivityActionType.PLUGIN_DISABLED,
                action: 'work.plugin_disabled',
                status: ActivityStatus.COMPLETED,
                summary: 'Disabled plugin p for work',
            });
            expect(result).toEqual({ id: 'p' });
        });

        it('does not emit log when ensureCanEdit rejects', async () => {
            ownershipService.ensureCanEdit.mockRejectedValue(new Error('forbidden'));

            await expect(controller.disableWorkPlugin(auth, 'w-1', 'p')).rejects.toThrow(
                'forbidden',
            );
            expect(pluginsService.disablePluginForWork).not.toHaveBeenCalled();
            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('does not emit log when service rejects', async () => {
            pluginsService.disablePluginForWork.mockRejectedValue(new Error('x'));

            await expect(controller.disableWorkPlugin(auth, 'w-1', 'p')).rejects.toThrow('x');
            expect(activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('updateWorkPluginSettings', () => {
        it('runs ensureCanEdit BEFORE updateWorkPluginSettings, calls tryValidateConnection WITH workId, emits work.plugin_configured log, returns merged {result, validation}', async () => {
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => order.push('edit'));
            pluginsService.updateWorkPluginSettings.mockImplementation(async () => {
                order.push('update');
                return { id: 'p', settings: {} };
            });
            pluginValidationService.tryValidateConnection.mockResolvedValue({
                success: true,
                message: 'ok',
            });
            const dto: any = {
                settings: { x: 1 },
                secretSettings: { y: 2 },
                metadata: { z: 3 },
            };

            const result = await controller.updateWorkPluginSettings(auth, 'w-1', 'p', dto);

            expect(order).toEqual(['edit', 'update']);
            expect(pluginsService.updateWorkPluginSettings).toHaveBeenCalledWith(
                'w-1',
                'p',
                'user-1',
                { x: 1 },
                { y: 2 },
                { z: 3 },
            );
            expect(pluginValidationService.tryValidateConnection).toHaveBeenCalledWith(
                'p',
                'user-1',
                'w-1',
            );
            expect(activityLogService.log).toHaveBeenCalledWith({
                userId: 'user-1',
                workId: 'w-1',
                actionType: ActivityActionType.PLUGIN_CONFIGURED,
                action: 'work.plugin_configured',
                status: ActivityStatus.COMPLETED,
                summary: 'Updated plugin settings for p',
            });
            expect(result).toEqual({
                id: 'p',
                settings: {},
                validation: { success: true, message: 'ok' },
            });
        });

        it('returns validation:null when tryValidateConnection returns null', async () => {
            pluginsService.updateWorkPluginSettings.mockResolvedValue({ id: 'p' });
            pluginValidationService.tryValidateConnection.mockResolvedValue(null);

            const result = await controller.updateWorkPluginSettings(
                auth,
                'w-1',
                'p',
                {} as any,
            );

            expect(result).toEqual({ id: 'p', validation: null });
        });

        it('does not call update or log when ensureCanEdit rejects', async () => {
            ownershipService.ensureCanEdit.mockRejectedValue(new Error('nope'));

            await expect(
                controller.updateWorkPluginSettings(auth, 'w-1', 'p', {} as any),
            ).rejects.toThrow('nope');
            expect(pluginsService.updateWorkPluginSettings).not.toHaveBeenCalled();
            expect(pluginValidationService.tryValidateConnection).not.toHaveBeenCalled();
            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('does not emit log when update rejects (and never calls tryValidateConnection)', async () => {
            pluginsService.updateWorkPluginSettings.mockRejectedValue(new Error('boom'));

            await expect(
                controller.updateWorkPluginSettings(auth, 'w-1', 'p', {} as any),
            ).rejects.toThrow('boom');
            expect(pluginValidationService.tryValidateConnection).not.toHaveBeenCalled();
            expect(activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('setActiveCapability', () => {
        it('runs ensureCanEdit BEFORE setActiveCapability and forwards positional args (workId, pluginId, userId, capability)', async () => {
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => order.push('edit'));
            pluginsService.setActiveCapability.mockImplementation(async () => {
                order.push('set');
                return { id: 'p', activeCapability: 'search' };
            });

            const result = await controller.setActiveCapability(auth, 'w-1', 'p', {
                capability: 'search',
            } as any);

            expect(order).toEqual(['edit', 'set']);
            expect(pluginsService.setActiveCapability).toHaveBeenCalledWith(
                'w-1',
                'p',
                'user-1',
                'search',
            );
            expect(result).toEqual({ id: 'p', activeCapability: 'search' });
        });

        it('does NOT emit any activity log (pinned)', async () => {
            pluginsService.setActiveCapability.mockResolvedValue({});

            await controller.setActiveCapability(auth, 'w-1', 'p', {
                capability: 'search',
            } as any);

            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('skips setActiveCapability when ensureCanEdit rejects', async () => {
            ownershipService.ensureCanEdit.mockRejectedValue(new Error('forbidden'));

            await expect(
                controller.setActiveCapability(auth, 'w-1', 'p', { capability: 'x' } as any),
            ).rejects.toThrow('forbidden');
            expect(pluginsService.setActiveCapability).not.toHaveBeenCalled();
        });
    });
});
