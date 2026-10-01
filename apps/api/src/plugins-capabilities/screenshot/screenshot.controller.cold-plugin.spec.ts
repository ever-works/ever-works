jest.mock('@ever-works/agent/facades', () => ({
    ScreenshotFacadeService: class {},
    NoProviderError: class NoProviderError extends Error {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
}));
jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { IPlugin, JsonSchema, PluginManifest } from '@ever-works/plugin';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import type { PluginSettingsService } from '@ever-works/agent/plugins';
import type { ScreenshotFacadeService } from '@ever-works/agent/facades';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { ScreenshotController } from './screenshot.controller';

const REQUIRED_API_KEY: JsonSchema = {
    type: 'object',
    properties: { apiKey: { type: 'string', 'x-secret': true } },
    required: ['apiKey'],
} as unknown as JsonSchema;

/**
 * Screenshot providers over a provider the registry holds as a COLD lazy
 * proxy (a REAL `PluginRegistryService.registerLazy`) — screenshotone and
 * urlbox are discovered on disk and stay cold until first use. A provider
 * whose required API key nobody configured must be reported as not
 * configured, and capture must refuse to run on it.
 */
describe('ScreenshotController — cold lazy screenshot provider', () => {
    const auth = { userId: 'user-1' } as AuthenticatedUser;

    function build(settings: Record<string, unknown>) {
        const registry = new PluginRegistryService(new EventEmitter2());
        registry.registerLazy(
            {
                id: 'cold-shot',
                name: 'Cold Shot',
                version: '1.0.0',
                description: 'cold fixture',
                category: 'screenshot',
                capabilities: [PLUGIN_CAPABILITIES.SCREENSHOT],
                autoEnable: true,
            } as PluginManifest,
            async () =>
                ({
                    id: 'cold-shot',
                    name: 'Cold Shot',
                    version: '1.0.0',
                    category: 'screenshot',
                    capabilities: [PLUGIN_CAPABILITIES.SCREENSHOT],
                    settingsSchema: REQUIRED_API_KEY,
                    onLoad: async () => undefined,
                    onUnload: async () => undefined,
                }) as unknown as IPlugin,
        );
        const screenshotFacade = { capture: jest.fn() };
        const controller = new ScreenshotController(
            screenshotFacade as unknown as ScreenshotFacadeService,
            registry,
            {
                getSettings: jest.fn().mockResolvedValue(settings),
            } as unknown as PluginSettingsService,
            { ensureCanView: jest.fn() } as unknown as WorkOwnershipService,
        );
        return { controller, screenshotFacade };
    }

    it('reports the cold provider as not configured while it has no API key', async () => {
        const { controller } = build({});

        const result = await controller.checkAvailability(auth);

        expect(result.available).toBe(false);
        expect(result.providers).toEqual([
            expect.objectContaining({ id: 'cold-shot', configured: false }),
        ]);
    });

    it('refuses to capture with the unconfigured cold provider', async () => {
        const { controller, screenshotFacade } = build({});

        await expect(
            controller.capture(auth, { url: 'https://example.com' } as never),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(screenshotFacade.capture).not.toHaveBeenCalled();
    });

    it('reports the cold provider configured once its API key is set', async () => {
        const { controller } = build({ apiKey: 'sk-shot' });

        const result = await controller.checkAvailability(auth);

        expect(result.available).toBe(true);
        expect(result.providers).toEqual([
            expect.objectContaining({ id: 'cold-shot', configured: true }),
        ]);
    });
});
