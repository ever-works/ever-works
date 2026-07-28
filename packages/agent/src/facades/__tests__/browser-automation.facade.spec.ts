import { Test, TestingModule } from '@nestjs/testing';
import { BrowserAutomationFacadeService } from '../browser-automation.facade';
import { buildBrowserTools } from '../agent-browser-tools';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { IBrowserAutomationPlugin, PluginManifest } from '@ever-works/plugin';

describe('BrowserAutomationFacadeService', () => {
    let service: BrowserAutomationFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;

    const facadeOptions = { userId: 'test-user' };

    const handle = {
        sessionId: 'session-1',
        policy: {
            allowedHosts: ['example.com'],
            subresourcePolicy: 'public-only' as const,
            allowPrivateNetwork: false,
            timeoutMs: 30_000,
            headless: true,
        },
    };

    const createMockPlugin = (): jest.Mocked<IBrowserAutomationPlugin> =>
        ({
            id: 'browser-automation',
            name: 'Browser Automation',
            version: '1.0.0',
            category: 'utility',
            capabilities: ['browser-automation'],
            settingsSchema: { type: 'object', properties: {} },
            providerName: 'Playwright',
            onLoad: jest.fn(),
            onUnload: jest.fn(),
            open: jest.fn().mockResolvedValue(handle),
            navigate: jest.fn().mockResolvedValue({
                url: 'https://example.com/final',
                status: 200,
                title: 'Example',
                redirectChain: ['https://example.com', 'https://example.com/final'],
                blockedRequests: [
                    { url: 'https://ads.test/x.js', reason: 'host-not-allowed', navigation: false },
                ],
            }),
            extract: jest.fn().mockResolvedValue({ values: ['hello'], truncated: false }),
            screenshot: jest
                .fn()
                .mockResolvedValue({ base64: 'aGk=', contentType: 'image/png', bytes: 2 }),
            act: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        }) as unknown as jest.Mocked<IBrowserAutomationPlugin>;

    const register = (plugin: IBrowserAutomationPlugin): RegisteredPlugin =>
        ({
            plugin: plugin as any,
            manifest: {
                id: plugin.id,
                name: plugin.name,
                version: plugin.version,
                description: 'Test plugin',
                category: plugin.category,
                capabilities: ['browser-automation'],
            } as PluginManifest,
            state: 'loaded',
            builtIn: false,
            stateHistory: [],
            registeredAt: Date.now(),
        }) as RegisteredPlugin;

    let plugin: jest.Mocked<IBrowserAutomationPlugin>;

    beforeEach(async () => {
        plugin = createMockPlugin();
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BrowserAutomationFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([register(plugin)]),
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: { getSettings: jest.fn().mockResolvedValue({}) },
                },
            ],
        }).compile();

        service = module.get(BrowserAutomationFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
    });

    describe('read', () => {
        it('opens, navigates, extracts and closes in one call', async () => {
            const result = await service.read({ url: 'https://example.com' }, facadeOptions);

            expect(plugin.open).toHaveBeenCalledTimes(1);
            expect(plugin.navigate).toHaveBeenCalledWith(handle, 'https://example.com');
            expect(plugin.extract).toHaveBeenCalledWith(handle, { format: 'text' });
            expect(plugin.close).toHaveBeenCalledWith(handle);

            expect(result.url).toBe('https://example.com/final');
            expect(result.values).toEqual(['hello']);
            expect(result.redirectChain).toHaveLength(2);
        });

        it('surfaces blocked sub-resources rather than swallowing them', async () => {
            // "The page looked empty" and "half the page was refused" are
            // different answers; the caller has to be able to tell.
            const result = await service.read({ url: 'https://example.com' }, facadeOptions);
            expect(result.blockedRequests).toHaveLength(1);
            expect(result.blockedRequests[0].url).toBe('https://ads.test/x.js');
        });

        it('closes the session even when navigation is refused', async () => {
            plugin.navigate.mockRejectedValueOnce(
                new Error('navigation blocked: host-not-allowed'),
            );

            await expect(service.read({ url: 'https://evil.test' }, facadeOptions)).rejects.toThrow(
                'navigation blocked',
            );

            // The whole reason `read` is one-shot: an unhappy path must not
            // leak a browser context.
            expect(plugin.close).toHaveBeenCalledWith(handle);
        });

        it('does not let a failed close mask the real result', async () => {
            plugin.close.mockRejectedValueOnce(new Error('context already gone'));

            await expect(
                service.read({ url: 'https://example.com' }, facadeOptions),
            ).resolves.toMatchObject({ values: ['hello'] });
        });

        it('injects resolved settings into the session spec', async () => {
            settingsService.getSettings.mockResolvedValueOnce({ allowedHosts: 'example.com' });

            await service.read({ url: 'https://example.com' }, facadeOptions);

            expect(plugin.open).toHaveBeenCalledWith(
                expect.objectContaining({ settings: { allowedHosts: 'example.com' } }),
            );
        });
    });

    describe('capture', () => {
        it('returns the shot alongside the post-redirect URL and closes', async () => {
            const result = await service.capture(
                { url: 'https://example.com', screenshot: { fullPage: true } },
                facadeOptions,
            );

            expect(plugin.screenshot).toHaveBeenCalledWith(handle, { fullPage: true });
            expect(result).toMatchObject({
                contentType: 'image/png',
                url: 'https://example.com/final',
            });
            expect(plugin.close).toHaveBeenCalledWith(handle);
        });
    });

    describe('isAvailable', () => {
        it('is false when no browser-automation plugin is loaded', () => {
            registry.getByCapability.mockReturnValue([]);
            expect(service.isAvailable()).toBe(false);
        });

        it('is true when one is', () => {
            expect(service.isAvailable()).toBe(true);
        });
    });
});

describe('buildBrowserTools', () => {
    const read = jest.fn().mockResolvedValue({
        url: 'https://example.com',
        status: 200,
        title: 'Example',
        redirectChain: [],
        values: ['hi'],
        truncated: false,
        blockedRequests: [],
    });
    const tools = () => buildBrowserTools({ userId: 'u1', facade: { read } as any });

    beforeEach(() => read.mockClear());

    it('exposes exactly one, read-only tool', () => {
        const names = tools().map((t) => t.name);
        // `act` is on the capability but deliberately not offered: driving a
        // page can submit forms and trip irreversible actions.
        expect(names).toEqual(['browse_url']);
    });

    it('scopes the read to the owning user', async () => {
        await tools()[0].invoke({ url: 'https://example.com' });
        expect(read).toHaveBeenCalledWith(expect.anything(), { userId: 'u1' });
    });

    it('refuses a non-http scheme before reaching the provider', async () => {
        const result = await tools()[0].invoke({ url: 'file:///etc/passwd' });
        expect(result).toEqual({ error: 'url must be an absolute http(s) URL' });
        expect(read).not.toHaveBeenCalled();
    });

    it('requires a url', async () => {
        expect(await tools()[0].invoke({})).toEqual({ error: 'url is required' });
        expect(await tools()[0].invoke({ url: '   ' })).toEqual({ error: 'url is required' });
        expect(read).not.toHaveBeenCalled();
    });

    it('requires an attribute name when format is attribute', async () => {
        const result = await tools()[0].invoke({
            url: 'https://example.com',
            format: 'attribute',
        });
        expect(result).toEqual({ error: 'attribute is required when format is "attribute"' });
        expect(read).not.toHaveBeenCalled();
    });

    it('falls back to text for an unrecognized format and clamps the limit', async () => {
        await tools()[0].invoke({ url: 'https://example.com', format: 'pdf', limit: 9999 });
        expect(read).toHaveBeenCalledWith(
            expect.objectContaining({
                query: expect.objectContaining({ format: 'text', limit: 100 }),
            }),
            expect.anything(),
        );
    });

    it('reports a provider refusal as a tool error, not a throw', async () => {
        read.mockRejectedValueOnce(new Error('navigation blocked: host-not-allowed'));
        const result = await tools()[0].invoke({ url: 'https://internal.test' });
        expect(result).toEqual({ error: 'navigation blocked: host-not-allowed' });
    });
});
