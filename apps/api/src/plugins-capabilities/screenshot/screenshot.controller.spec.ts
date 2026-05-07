jest.mock('@ever-works/agent/facades', () => ({
    ScreenshotFacadeService: class {},
    NoProviderError: class NoProviderError extends Error {
        constructor(capability?: string) {
            super(`No provider for ${capability ?? 'unknown'}`);
            this.name = 'NoProviderError';
        }
    },
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginRegistryService: class {},
    PluginSettingsService: class {},
}));
jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { ScreenshotController } from './screenshot.controller';
import { NoProviderError } from '@ever-works/agent/facades';
import type { ScreenshotFacadeService } from '@ever-works/agent/facades';
import type { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

describe('ScreenshotController', () => {
    let screenshotFacade: { capture: jest.Mock; getScreenshotUrl: jest.Mock };
    let pluginRegistry: {
        getEnabledPluginsScoped: jest.Mock;
        getDefaultForCapabilityScoped: jest.Mock;
    };
    let pluginSettings: { getSettings: jest.Mock };
    let controller: ScreenshotController;
    const auth: AuthenticatedUser = { userId: 'user-1' } as any;

    beforeEach(() => {
        screenshotFacade = { capture: jest.fn(), getScreenshotUrl: jest.fn() };
        pluginRegistry = {
            getEnabledPluginsScoped: jest.fn(),
            getDefaultForCapabilityScoped: jest.fn(),
        };
        pluginSettings = { getSettings: jest.fn() };
        controller = new ScreenshotController(
            screenshotFacade as unknown as ScreenshotFacadeService,
            pluginRegistry as unknown as PluginRegistryService,
            pluginSettings as unknown as PluginSettingsService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    const registered = (
        id: string,
        opts: {
            name?: string;
            description?: string;
            icon?: string;
            isDefault?: boolean;
            systemPlugin?: boolean;
            requiredSettings?: string[];
            schemaProperties?: Record<string, Record<string, unknown>>;
        } = {},
    ) => ({
        plugin: {
            id,
            name: opts.name ?? id,
            settingsSchema: opts.requiredSettings
                ? {
                      type: 'object',
                      required: opts.requiredSettings,
                      properties: opts.schemaProperties ?? {},
                  }
                : undefined,
        },
        manifest: {
            description: opts.description,
            icon: opts.icon,
            defaultForCapabilities: opts.isDefault ? ['screenshot'] : undefined,
            systemPlugin: opts.systemPlugin,
        },
    });

    describe('checkAvailability', () => {
        it('returns available:true when at least one provider is configured', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([
                registered('screenshotone', { name: 'ScreenshotOne' }),
            ]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(pluginRegistry.getEnabledPluginsScoped).toHaveBeenCalledWith(
                'screenshot',
                undefined,
                'user-1',
            );
            expect(pluginRegistry.getDefaultForCapabilityScoped).toHaveBeenCalledWith(
                'screenshot',
                undefined,
                'user-1',
            );
            expect(result).toEqual(
                expect.objectContaining({
                    status: 'success',
                    available: true,
                }),
            );
            expect(result.providers).toHaveLength(1);
            expect(result.providers[0]).toEqual(
                expect.objectContaining({
                    id: 'screenshotone',
                    name: 'ScreenshotOne',
                    configured: true,
                }),
            );
        });

        it('returns available:false when all providers lack required settings', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([
                registered('screenshotone', {
                    requiredSettings: ['apiKey'],
                    schemaProperties: { apiKey: { type: 'string' } },
                }),
            ]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(result.available).toBe(false);
            expect(result.providers[0].configured).toBe(false);
        });

        it('forwards workId to both registry calls and pluginSettings.getSettings', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            await controller.checkAvailability(auth, 'work-42');

            expect(pluginRegistry.getEnabledPluginsScoped).toHaveBeenCalledWith(
                'screenshot',
                'work-42',
                'user-1',
            );
            expect(pluginRegistry.getDefaultForCapabilityScoped).toHaveBeenCalledWith(
                'screenshot',
                'work-42',
                'user-1',
            );
            expect(pluginSettings.getSettings).toHaveBeenCalledWith('p', {
                userId: 'user-1',
                workId: 'work-42',
                includeSecrets: true,
            });
        });

        it('marks the active provider returned by getDefaultForCapabilityScoped as isDefault=true', async () => {
            const a = registered('a', { name: 'A' });
            const b = registered('b', { name: 'B' });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([a, b]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(b);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            const provB = result.providers.find((p) => p.id === 'b')!;
            const provA = result.providers.find((p) => p.id === 'a')!;
            expect(provB.isDefault).toBe(true);
            expect(provA.isDefault).toBe(false);
            expect(result.activeProvider?.id).toBe('b');
        });

        it('falls back to manifest.defaultForCapabilities when no active provider', async () => {
            const nonDefault = registered('a', { name: 'A' });
            const defaultPlugin = registered('b', { name: 'B', isDefault: true });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([nonDefault, defaultPlugin]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            const provB = result.providers.find((p) => p.id === 'b')!;
            expect(provB.isDefault).toBe(true);
            // activeProvider falls back to first isDefault when no active id
            expect(result.activeProvider?.id).toBe('b');
        });

        it('falls back to manifest.systemPlugin when no defaultForCapabilities and no active provider', async () => {
            const sysPlugin = registered('local', { systemPlugin: true });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([sysPlugin]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(result.providers[0].isDefault).toBe(true);
        });

        it('sorts providers: default first, configured second, name alphabetical third', async () => {
            // Two non-default plugins, both configured: alphabetical
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([
                registered('zeta', { name: 'Zeta' }),
                registered('alpha', { name: 'Alpha' }),
            ]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(result.providers.map((p) => p.id)).toEqual(['alpha', 'zeta']);
        });

        it('sorts default-for-capability before non-default even when non-default is alphabetically first', async () => {
            const def = registered('zeta', { name: 'Zeta', isDefault: true });
            const nondef = registered('alpha', { name: 'Alpha' });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([nondef, def]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(result.providers.map((p) => p.id)).toEqual(['zeta', 'alpha']);
        });

        it('sorts configured before unconfigured when default-rank ties', async () => {
            const unconfigured = registered('a', {
                name: 'A',
                requiredSettings: ['apiKey'],
                schemaProperties: { apiKey: { type: 'string' } },
            });
            const configured = registered('b', { name: 'B' });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([unconfigured, configured]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockImplementation(async (id: string) =>
                id === 'a' ? {} : { random: 'ok' },
            );

            const result = await controller.checkAvailability(auth);

            // both same default rank (neither isDefault), so configured first
            expect(result.providers.map((p) => p.id)).toEqual(['b', 'a']);
        });

        it('returns activeProvider:null when no providers exist', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);

            const result = await controller.checkAvailability(auth);

            expect(result.providers).toEqual([]);
            expect(result.activeProvider).toBeNull();
            expect(result.available).toBe(false);
        });

        it('exposes manifest.description and manifest.icon on each ProviderOption', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([
                registered('p', {
                    description: 'a screenshot tool',
                    icon: 'https://x/icon.png',
                }),
            ]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(result.providers[0]).toEqual(
                expect.objectContaining({
                    description: 'a screenshot tool',
                    icon: 'https://x/icon.png',
                }),
            );
        });
    });

    describe('capture', () => {
        const dto = {
            url: 'https://example.com',
            workId: 'work-1',
            providerOverride: 'screenshotone',
            viewportWidth: 1280,
            viewportHeight: 720,
            format: 'png' as const,
            fullPage: true,
            delay: 500,
            blockAds: true,
            blockTrackers: false,
            blockCookieBanners: true,
        };

        it('throws BadRequestException with "No screenshot provider configured" when none configured', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);

            try {
                await controller.capture(auth, dto);
                fail('expected throw');
            } catch (e: any) {
                expect(e).toBeInstanceOf(BadRequestException);
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message: 'No screenshot provider configured',
                });
            }
            expect(screenshotFacade.capture).not.toHaveBeenCalled();
        });

        it('forwards options + context to screenshotFacade.capture and returns success envelope (cacheUrl over imageUrl)', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('screenshotone')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            screenshotFacade.capture.mockResolvedValue({
                success: true,
                imageUrl: 'https://primary/img.png',
                cacheUrl: 'https://cache/img.png',
                imageBuffer: undefined,
            });

            const result = await controller.capture(auth, dto);

            expect(screenshotFacade.capture).toHaveBeenCalledWith(
                {
                    url: dto.url,
                    viewportWidth: dto.viewportWidth,
                    viewportHeight: dto.viewportHeight,
                    format: dto.format,
                    fullPage: dto.fullPage,
                    delay: dto.delay,
                    blockAds: dto.blockAds,
                    blockTrackers: dto.blockTrackers,
                    blockCookieBanners: dto.blockCookieBanners,
                },
                {
                    userId: 'user-1',
                    workId: 'work-1',
                    providerOverride: 'screenshotone',
                },
            );

            expect(result).toEqual({
                status: 'success',
                imageUrl: 'https://cache/img.png',
                cacheUrl: 'https://cache/img.png',
                imageBase64: null,
            });
        });

        it('falls back to imageUrl when cacheUrl missing', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            screenshotFacade.capture.mockResolvedValue({
                success: true,
                imageUrl: 'https://primary/img.png',
                cacheUrl: undefined,
            });

            const result = await controller.capture(auth, dto);

            expect(result.imageUrl).toBe('https://primary/img.png');
            expect(result.cacheUrl).toBeUndefined();
        });

        it('encodes imageBuffer as base64 when present', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            const buffer = Buffer.from('fake-png-bytes', 'utf8');
            screenshotFacade.capture.mockResolvedValue({
                success: true,
                imageUrl: 'https://x/i.png',
                imageBuffer: buffer,
            });

            const result = await controller.capture(auth, dto);

            expect(result.imageBase64).toBe(buffer.toString('base64'));
        });

        it('wraps NoProviderError in BadRequestException with "configured or available" message', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});
            screenshotFacade.capture.mockRejectedValue(new NoProviderError('screenshot'));

            try {
                await controller.capture(auth, dto);
                fail('expected throw');
            } catch (e: any) {
                expect(e).toBeInstanceOf(BadRequestException);
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message: 'No screenshot provider configured or available',
                });
            }
        });

        it('rethrows non-NoProviderError errors unchanged', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});
            const err = new Error('upstream blew up');
            screenshotFacade.capture.mockRejectedValue(err);

            await expect(controller.capture(auth, dto)).rejects.toBe(err);
        });

        it('throws BadRequestException with result.error when result.success=false', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});
            screenshotFacade.capture.mockResolvedValue({
                success: false,
                error: 'site blocked us',
            });

            try {
                await controller.capture(auth, dto);
                fail('expected throw');
            } catch (e: any) {
                expect(e).toBeInstanceOf(BadRequestException);
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message: 'site blocked us',
                });
            }
        });

        it('falls back to "Failed to capture screenshot" when result.error missing', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});
            screenshotFacade.capture.mockResolvedValue({ success: false });

            try {
                await controller.capture(auth, dto);
                fail('expected throw');
            } catch (e: any) {
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message: 'Failed to capture screenshot',
                });
            }
        });
    });

    describe('getScreenshotUrl', () => {
        const dto = {
            url: 'https://example.com',
            workId: 'work-1',
            providerOverride: 'urlbox',
            viewportWidth: 1280,
            viewportHeight: 720,
            format: 'png' as const,
            fullPage: false,
            delay: 0,
            blockAds: false,
            blockTrackers: false,
            blockCookieBanners: false,
        };

        it('throws BadRequestException with "No screenshot provider configured" when none configured', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);

            try {
                await controller.getScreenshotUrl(auth, dto);
                fail('expected throw');
            } catch (e: any) {
                expect(e).toBeInstanceOf(BadRequestException);
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message: 'No screenshot provider configured',
                });
            }
            expect(screenshotFacade.getScreenshotUrl).not.toHaveBeenCalled();
        });

        it('forwards options + context to screenshotFacade.getScreenshotUrl and returns { status, imageUrl }', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            screenshotFacade.getScreenshotUrl.mockResolvedValue('https://shot.test/img.png');

            const result = await controller.getScreenshotUrl(auth, dto);

            expect(screenshotFacade.getScreenshotUrl).toHaveBeenCalledWith(
                {
                    url: dto.url,
                    viewportWidth: dto.viewportWidth,
                    viewportHeight: dto.viewportHeight,
                    format: dto.format,
                    fullPage: dto.fullPage,
                    delay: dto.delay,
                    blockAds: dto.blockAds,
                    blockTrackers: dto.blockTrackers,
                    blockCookieBanners: dto.blockCookieBanners,
                },
                {
                    userId: 'user-1',
                    workId: 'work-1',
                    providerOverride: 'urlbox',
                },
            );
            expect(result).toEqual({
                status: 'success',
                imageUrl: 'https://shot.test/img.png',
            });
        });

        it('wraps NoProviderError in BadRequestException with "configured or available" message', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});
            screenshotFacade.getScreenshotUrl.mockRejectedValue(new NoProviderError('screenshot'));

            try {
                await controller.getScreenshotUrl(auth, dto);
                fail('expected throw');
            } catch (e: any) {
                expect(e).toBeInstanceOf(BadRequestException);
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message: 'No screenshot provider configured or available',
                });
            }
        });

        it('rethrows non-NoProviderError errors unchanged', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});
            const err = new Error('signing failure');
            screenshotFacade.getScreenshotUrl.mockRejectedValue(err);

            await expect(controller.getScreenshotUrl(auth, dto)).rejects.toBe(err);
        });

        it('throws BadRequestException "Failed to generate screenshot URL" when imageUrl is null/empty', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('p')]);
            pluginRegistry.getDefaultForCapabilityScoped.mockResolvedValue(null);
            pluginSettings.getSettings.mockResolvedValue({});

            for (const value of [null, '', undefined]) {
                screenshotFacade.getScreenshotUrl.mockResolvedValue(value);
                try {
                    await controller.getScreenshotUrl(auth, dto);
                    fail('expected throw');
                } catch (e: any) {
                    expect(e).toBeInstanceOf(BadRequestException);
                    expect(e.getResponse()).toEqual({
                        status: 'error',
                        message: 'Failed to generate screenshot URL',
                    });
                }
            }
        });
    });
});
