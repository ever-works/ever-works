jest.mock('@ever-works/agent/facades', () => ({
    SearchFacadeService: class {},
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
import { SearchController } from './search.controller';
import { NoProviderError } from '@ever-works/agent/facades';
import type { SearchFacadeService } from '@ever-works/agent/facades';
import type { PluginRegistryService, PluginSettingsService } from '@ever-works/agent/plugins';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

describe('SearchController', () => {
    let searchFacade: { search: jest.Mock };
    let pluginRegistry: { getEnabledPluginsScoped: jest.Mock };
    let pluginSettings: { getSettings: jest.Mock };
    let controller: SearchController;
    const auth: AuthenticatedUser = { userId: 'user-1' } as any;

    beforeEach(() => {
        searchFacade = { search: jest.fn() };
        pluginRegistry = { getEnabledPluginsScoped: jest.fn() };
        pluginSettings = { getSettings: jest.fn() };
        controller = new SearchController(
            searchFacade as unknown as SearchFacadeService,
            pluginRegistry as unknown as PluginRegistryService,
            pluginSettings as unknown as PluginSettingsService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Helper to build a registered plugin shape
    const registered = (
        id: string,
        opts: {
            name?: string;
            isDefault?: boolean;
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
            defaultForCapabilities: opts.isDefault ? ['search'] : undefined,
        },
    });

    describe('checkAvailability', () => {
        it('returns available:false with "No search provider is enabled" when no plugins enabled', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([]);

            const result = await controller.checkAvailability(auth);

            expect(pluginRegistry.getEnabledPluginsScoped).toHaveBeenCalledWith(
                'search',
                undefined,
                'user-1',
            );
            expect(result).toEqual({
                status: 'success',
                available: false,
                activeProvider: null,
                message:
                    'No search provider is enabled. Enable a search plugin (e.g. Tavily, Linkup, Brave, Exa) in settings.',
            });
        });

        it('returns available:false with "enabled but unconfigured" message when plugin enabled but missing required setting', async () => {
            const plugin = registered('tavily', {
                requiredSettings: ['apiKey'],
                schemaProperties: { apiKey: { type: 'string' } },
            });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([plugin]);
            pluginSettings.getSettings.mockResolvedValue({}); // no apiKey

            const result = await controller.checkAvailability(auth);

            expect(result).toEqual({
                status: 'success',
                available: false,
                activeProvider: null,
                message:
                    'Search plugins are enabled but none have all required settings configured (e.g. API key).',
            });
        });

        it('returns available:true with first configured provider', async () => {
            const plugin = registered('tavily', { name: 'Tavily' });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([plugin]);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(result).toEqual({
                status: 'success',
                available: true,
                activeProvider: { id: 'tavily', name: 'Tavily' },
            });
        });

        it('passes resolved settings (4-level merge incl. secrets) by setting includeSecrets:true + userId', async () => {
            const plugin = registered('tavily');
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([plugin]);
            pluginSettings.getSettings.mockResolvedValue({});

            await controller.checkAvailability(auth);

            expect(pluginSettings.getSettings).toHaveBeenCalledWith('tavily', {
                userId: 'user-1',
                includeSecrets: true,
            });
        });

        it('treats null/undefined/empty-string as missing required setting', async () => {
            for (const value of [null, undefined, '']) {
                pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([
                    registered('p', {
                        requiredSettings: ['apiKey'],
                        schemaProperties: { apiKey: { type: 'string' } },
                    }),
                ]);
                pluginSettings.getSettings.mockResolvedValue({ apiKey: value });

                const result = await controller.checkAvailability(auth);
                expect(result.available).toBe(false);
            }
        });

        it('skips fields marked with x-envVar in required check', async () => {
            const plugin = registered('p', {
                requiredSettings: ['envSecret', 'apiKey'],
                schemaProperties: {
                    envSecret: { type: 'string', 'x-envVar': 'PLUGIN_SECRET' },
                    apiKey: { type: 'string' },
                },
            });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([plugin]);
            pluginSettings.getSettings.mockResolvedValue({ apiKey: 'real-key' });

            const result = await controller.checkAvailability(auth);

            expect(result).toEqual(
                expect.objectContaining({
                    available: true,
                    activeProvider: { id: 'p', name: 'p' },
                }),
            );
        });

        it('skips fields marked with x-adminOnly in required check', async () => {
            const plugin = registered('p', {
                requiredSettings: ['adminThing', 'apiKey'],
                schemaProperties: {
                    adminThing: { type: 'string', 'x-adminOnly': true },
                    apiKey: { type: 'string' },
                },
            });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([plugin]);
            pluginSettings.getSettings.mockResolvedValue({ apiKey: 'k' });

            const result = await controller.checkAvailability(auth);

            expect(result.available).toBe(true);
        });

        it('returns available:true when settingsSchema is undefined (no required check)', async () => {
            const plugin = registered('no-schema');
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([plugin]);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(result.available).toBe(true);
        });

        it('returns available:true when schema has required but no properties (continue-skips field)', async () => {
            const plugin = {
                plugin: {
                    id: 'p',
                    name: 'P',
                    settingsSchema: {
                        type: 'object',
                        required: ['nope'],
                        // properties intentionally absent
                    },
                },
                manifest: {},
            };
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([plugin]);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(result.available).toBe(true);
        });

        it('sorts default-for-capability plugin first, returning it before non-default', async () => {
            const nonDefault = registered('brave', { name: 'Brave' });
            const defaultPlugin = registered('tavily', { name: 'Tavily', isDefault: true });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([nonDefault, defaultPlugin]);
            pluginSettings.getSettings.mockResolvedValue({});

            const result = await controller.checkAvailability(auth);

            expect(result.activeProvider).toEqual({ id: 'tavily', name: 'Tavily' });
        });

        it('falls back to non-default when default plugin lacks required settings', async () => {
            const fallback = registered('brave', { name: 'Brave' });
            const defaultButUnconfigured = registered('tavily', {
                name: 'Tavily',
                isDefault: true,
                requiredSettings: ['apiKey'],
                schemaProperties: { apiKey: { type: 'string' } },
            });
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([
                fallback,
                defaultButUnconfigured,
            ]);
            pluginSettings.getSettings.mockImplementation(async (id: string) =>
                id === 'tavily' ? {} : { random: 'whatever' },
            );

            const result = await controller.checkAvailability(auth);

            expect(result.activeProvider).toEqual({ id: 'brave', name: 'Brave' });
        });
    });

    describe('search', () => {
        it('throws BadRequestException with "No search provider..." when no provider configured', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([]);

            const dto = { query: 'hello' } as any;

            await expect(controller.search(auth, dto)).rejects.toBeInstanceOf(BadRequestException);
            try {
                await controller.search(auth, dto);
            } catch (e: any) {
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message:
                        'No search provider with all required settings configured is available.',
                });
            }
            expect(searchFacade.search).not.toHaveBeenCalled();
        });

        it('forwards (query, options, context) to searchFacade.search and returns success envelope', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([
                registered('tavily', { name: 'Tavily' }),
            ]);
            pluginSettings.getSettings.mockResolvedValue({});
            searchFacade.search.mockResolvedValue([{ url: 'r1' }]);

            const dto = {
                query: 'hello',
                maxResults: 5,
                includeDomains: ['github.com'],
                excludeDomains: ['pinterest.com'],
            } as any;

            const result = await controller.search(auth, dto);

            expect(searchFacade.search).toHaveBeenCalledWith(
                'hello',
                {
                    maxResults: 5,
                    includeDomains: ['github.com'],
                    excludeDomains: ['pinterest.com'],
                },
                {
                    userId: 'user-1',
                    providerOverride: 'tavily',
                },
            );
            expect(result).toEqual({
                status: 'success',
                results: [{ url: 'r1' }],
                provider: 'Tavily',
            });
        });

        it('passes undefined for optional dto fields when omitted', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('tavily')]);
            pluginSettings.getSettings.mockResolvedValue({});
            searchFacade.search.mockResolvedValue([]);

            const dto = { query: 'q' } as any;

            await controller.search(auth, dto);

            expect(searchFacade.search).toHaveBeenCalledWith(
                'q',
                {
                    maxResults: undefined,
                    includeDomains: undefined,
                    excludeDomains: undefined,
                },
                expect.any(Object),
            );
        });

        it('wraps NoProviderError in BadRequestException with "Enable a search plugin" message', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('tavily')]);
            pluginSettings.getSettings.mockResolvedValue({});
            searchFacade.search.mockRejectedValue(new NoProviderError('search'));

            const dto = { query: 'q' } as any;

            await expect(controller.search(auth, dto)).rejects.toBeInstanceOf(BadRequestException);
            try {
                await controller.search(auth, dto);
            } catch (e: any) {
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message: 'No search provider configured. Enable a search plugin in settings.',
                });
            }
        });

        it('wraps generic Error rejection in BadRequestException with the original message', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('tavily')]);
            pluginSettings.getSettings.mockResolvedValue({});
            searchFacade.search.mockRejectedValue(new Error('rate limited'));

            const dto = { query: 'q' } as any;

            try {
                await controller.search(auth, dto);
                fail('expected throw');
            } catch (e: any) {
                expect(e).toBeInstanceOf(BadRequestException);
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message: 'rate limited',
                });
            }
        });

        it('wraps non-Error rejection with generic "Search failed" message', async () => {
            pluginRegistry.getEnabledPluginsScoped.mockResolvedValue([registered('tavily')]);
            pluginSettings.getSettings.mockResolvedValue({});
            searchFacade.search.mockRejectedValue('boom');

            const dto = { query: 'q' } as any;

            try {
                await controller.search(auth, dto);
                fail('expected throw');
            } catch (e: any) {
                expect(e).toBeInstanceOf(BadRequestException);
                expect(e.getResponse()).toEqual({
                    status: 'error',
                    message: 'Search failed',
                });
            }
        });
    });
});
