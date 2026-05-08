jest.mock('@ever-works/agent/plugins', () => ({
    PluginRegistryService: class {},
    PluginSettingsService: class {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    GitFacadeService: class {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PluginValidationService } from './plugin-validation.service';
import type { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import type { GitFacadeService } from '@ever-works/agent/facades';

describe('PluginValidationService', () => {
    let pluginRegistry: { get: jest.Mock };
    let pluginSettings: { getSettings: jest.Mock };
    let gitFacade: { getUser: jest.Mock };
    let service: PluginValidationService;

    beforeEach(() => {
        pluginRegistry = { get: jest.fn() };
        pluginSettings = { getSettings: jest.fn() };
        gitFacade = { getUser: jest.fn() };
        service = new PluginValidationService(
            pluginRegistry as unknown as PluginRegistryService,
            pluginSettings as unknown as PluginSettingsService,
            gitFacade as unknown as GitFacadeService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    const registered = (
        opts: {
            id?: string;
            name?: string;
            state?: string;
            capabilities?: string[];
            validateConnection?: jest.Mock;
            isAvailable?: jest.Mock;
        } = {},
    ) => {
        const plugin: Record<string, unknown> = {
            id: opts.id ?? 'plug-1',
            name: opts.name ?? 'Plug 1',
            capabilities: opts.capabilities ?? [],
        };
        if (opts.validateConnection) plugin.validateConnection = opts.validateConnection;
        if (opts.isAvailable) plugin.isAvailable = opts.isAvailable;
        return { state: opts.state ?? 'loaded', plugin };
    };

    describe('tryValidateConnection', () => {
        it('returns null when plugin is not registered', async () => {
            pluginRegistry.get.mockReturnValue(undefined);

            const result = await service.tryValidateConnection('missing', 'u-1');

            expect(result).toBeNull();
            expect(pluginSettings.getSettings).not.toHaveBeenCalled();
        });

        it('returns null when plugin is registered but not loaded', async () => {
            pluginRegistry.get.mockReturnValue(registered({ state: 'unloaded' }));

            const result = await service.tryValidateConnection('plug-1', 'u-1');

            expect(result).toBeNull();
            expect(pluginSettings.getSettings).not.toHaveBeenCalled();
        });

        it('returns null when plugin has none of validateConnection/isAvailable/git-provider', async () => {
            pluginRegistry.get.mockReturnValue(registered({ capabilities: ['ai-provider'] }));

            const result = await service.tryValidateConnection('plug-1', 'u-1');

            expect(result).toBeNull();
            expect(pluginSettings.getSettings).not.toHaveBeenCalled();
        });

        it('returns successful validateConnection result and forwards workId', async () => {
            const validateConnection = jest
                .fn()
                .mockResolvedValue({ success: true, message: 'OK' });
            pluginRegistry.get.mockReturnValue(
                registered({ capabilities: ['ai-provider'], validateConnection }),
            );
            pluginSettings.getSettings.mockResolvedValue({ apiKey: 'sk-x' });

            const result = await service.tryValidateConnection('plug-1', 'u-1', 'w-1');

            expect(result).toEqual({ success: true, message: 'OK' });
            expect(pluginSettings.getSettings).toHaveBeenCalledWith('plug-1', {
                userId: 'u-1',
                workId: 'w-1',
                includeSecrets: true,
            });
            expect(validateConnection).toHaveBeenCalledWith({ apiKey: 'sk-x' });
        });

        it('coerces BadRequestException with object body to {success:false, message, modelResults}', async () => {
            const validateConnection = jest
                .fn()
                .mockResolvedValue({
                    success: false,
                    message: 'bad',
                    modelResults: [{ ok: false }],
                });
            pluginRegistry.get.mockReturnValue(
                registered({ capabilities: ['ai-provider'], validateConnection }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await service.tryValidateConnection('plug-1', 'u-1');

            expect(result).toEqual({
                success: false,
                message: 'bad',
                modelResults: [{ ok: false }],
            });
        });

        it('falls back to "Validation failed" when BadRequestException body has no message', async () => {
            const validateConnection = jest.fn().mockImplementation(() => {
                throw new BadRequestException({ modelResults: [] });
            });
            pluginRegistry.get.mockReturnValue(
                registered({ capabilities: ['ai-provider'], validateConnection }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await service.tryValidateConnection('plug-1', 'u-1');

            expect(result).toEqual({
                success: false,
                message: 'Validation failed',
                modelResults: [],
            });
        });

        it('coerces BadRequestException with string response to {success:false, message:String(response)}', async () => {
            const validateConnection = jest.fn().mockImplementation(() => {
                throw new BadRequestException('Wrong creds');
            });
            pluginRegistry.get.mockReturnValue(
                registered({ capabilities: ['ai-provider'], validateConnection }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await service.tryValidateConnection('plug-1', 'u-1');

            // NestJS BadRequestException(string) returns an object response
            // with shape {message, error, statusCode}. The service treats that
            // object branch and reads body.message → 'Wrong creds'.
            expect(result).toEqual({
                success: false,
                message: 'Wrong creds',
                modelResults: undefined,
            });
        });

        it('returns null and warns on non-BadRequest errors', async () => {
            const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
            const validateConnection = jest.fn().mockRejectedValue(new Error('boom'));
            pluginRegistry.get.mockReturnValue(
                registered({ capabilities: ['ai-provider'], validateConnection }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await service.tryValidateConnection('plug-1', 'u-1');

            expect(result).toBeNull();
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('Connection validation failed for plugin');
        });

        it('returns null on timeout (warns)', async () => {
            jest.useFakeTimers();
            const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();

            // validateConnection never resolves
            const validateConnection = jest.fn().mockImplementation(() => new Promise(() => {}));
            pluginRegistry.get.mockReturnValue(
                registered({ capabilities: ['ai-provider'], validateConnection }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            const promise = service.tryValidateConnection('plug-1', 'u-1');
            // advance past the 20s timeout
            await jest.advanceTimersByTimeAsync(20_000);

            await expect(promise).resolves.toBeNull();
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('timed out');
        });

        it('uses git-provider branch when capabilities include git-provider and no validateConnection', async () => {
            pluginRegistry.get.mockReturnValue(
                registered({ name: 'GitHub', capabilities: ['git-provider'] }),
            );
            pluginSettings.getSettings.mockResolvedValue({});
            gitFacade.getUser.mockResolvedValue({ login: 'octo', email: 'oct@x.io' });

            const result = await service.tryValidateConnection('plug-1', 'u-1');

            expect(gitFacade.getUser).toHaveBeenCalledWith({
                userId: 'u-1',
                providerId: 'plug-1',
            });
            expect(result).toEqual({
                success: true,
                message: 'Connected to GitHub as octo.',
                details: { username: 'octo', email: 'oct@x.io' },
            });
        });

        it('falls back to isAvailable when no validateConnection and no git-provider', async () => {
            const isAvailable = jest.fn().mockResolvedValue(true);
            pluginRegistry.get.mockReturnValue(
                registered({ name: 'Local', capabilities: ['ai-provider'], isAvailable }),
            );
            pluginSettings.getSettings.mockResolvedValue({ token: 'x' });

            const result = await service.tryValidateConnection('plug-1', 'u-1');

            expect(isAvailable).toHaveBeenCalledWith({ token: 'x' });
            expect(result).toEqual({
                success: true,
                message: 'Local connection verified.',
            });
        });

        it('coerces isAvailable=false BadRequest to {success:false, message:"... connection test failed..."}', async () => {
            const isAvailable = jest.fn().mockResolvedValue(false);
            pluginRegistry.get.mockReturnValue(
                registered({ name: 'Local', capabilities: ['ai-provider'], isAvailable }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await service.tryValidateConnection('plug-1', 'u-1');

            expect(result).toEqual({
                success: false,
                message: 'Local connection test failed. Check your credentials and try again.',
                modelResults: undefined,
            });
        });
    });

    describe('validateUserPluginConnection (throwing alias)', () => {
        it('throws NotFoundException when plugin missing', async () => {
            pluginRegistry.get.mockReturnValue(undefined);

            await expect(service.validateUserPluginConnection('x', 'u-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('throws NotFoundException when plugin state is not "loaded"', async () => {
            pluginRegistry.get.mockReturnValue(registered({ state: 'failed' }));

            await expect(
                service.validateUserPluginConnection('plug-1', 'u-1'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('returns successful validateConnection result', async () => {
            const validateConnection = jest
                .fn()
                .mockResolvedValue({ success: true, message: 'all good' });
            pluginRegistry.get.mockReturnValue(
                registered({ capabilities: ['ai-provider'], validateConnection }),
            );
            pluginSettings.getSettings.mockResolvedValue({ k: 'v' });

            const result = await service.validateUserPluginConnection('plug-1', 'u-1');

            expect(result).toEqual({ success: true, message: 'all good' });
            expect(pluginSettings.getSettings).toHaveBeenCalledWith('plug-1', {
                userId: 'u-1',
                workId: undefined,
                includeSecrets: true,
            });
        });

        it('throws BadRequestException with {message, modelResults} when validateConnection returns success:false', async () => {
            const validateConnection = jest.fn().mockResolvedValue({
                success: false,
                message: 'bad',
                modelResults: [{ name: 'm1', ok: false }],
            });
            pluginRegistry.get.mockReturnValue(
                registered({ capabilities: ['ai-provider'], validateConnection }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            await expect(
                service.validateUserPluginConnection('plug-1', 'u-1'),
            ).rejects.toMatchObject({
                response: { message: 'bad', modelResults: [{ name: 'm1', ok: false }] },
            });
        });

        it('git-provider branch returns Connected message and forwards (userId, providerId)', async () => {
            pluginRegistry.get.mockReturnValue(
                registered({ name: 'GitHub', capabilities: ['git-provider'] }),
            );
            pluginSettings.getSettings.mockResolvedValue({});
            gitFacade.getUser.mockResolvedValue({ login: 'evereq', email: 'e@x' });

            const result = await service.validateUserPluginConnection('plug-1', 'u-1');

            expect(result).toEqual({
                success: true,
                message: 'Connected to GitHub as evereq.',
                details: { username: 'evereq', email: 'e@x' },
            });
        });

        it('isAvailable=false branch throws BadRequestException with credentials message', async () => {
            const isAvailable = jest.fn().mockResolvedValue(false);
            pluginRegistry.get.mockReturnValue(
                registered({ name: 'Cool', capabilities: ['ai-provider'], isAvailable }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            await expect(
                service.validateUserPluginConnection('plug-1', 'u-1'),
            ).rejects.toMatchObject({
                response: {
                    message: 'Cool connection test failed. Check your credentials and try again.',
                    statusCode: 400,
                },
            });
        });

        it('isAvailable=true branch returns generic verified message', async () => {
            const isAvailable = jest.fn().mockResolvedValue(true);
            pluginRegistry.get.mockReturnValue(
                registered({ name: 'Cool', capabilities: ['ai-provider'], isAvailable }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await service.validateUserPluginConnection('plug-1', 'u-1');

            expect(result).toEqual({ success: true, message: 'Cool connection verified.' });
        });

        it('returns generic "settings saved" when plugin has no validation/availability hooks but is git-provider-less is impossible — verified by tryValidateConnection guard', async () => {
            // The throwing variant only enters the "settings saved" fallback when
            // a plugin somehow makes it past tryValidateConnection's filter. We
            // pin the behavior directly by calling validateUserPluginConnection
            // with a plugin that has neither validateConnection, isAvailable,
            // nor git-provider capability — current code returns the saved
            // message because tryValidateConnection is a non-throwing wrapper
            // and the throwing variant routes here directly.
            pluginRegistry.get.mockReturnValue(
                registered({ name: 'Plain', capabilities: ['ai-provider'] }),
            );
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await service.validateUserPluginConnection('plug-1', 'u-1');

            expect(result).toEqual({ success: true, message: 'Plain settings saved.' });
        });
    });
});
