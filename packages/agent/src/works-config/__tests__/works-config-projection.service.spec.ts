import { WorksConfigProjectionService } from '../services/works-config-projection.service';

describe('WorksConfigProjectionService', () => {
    const directory = { id: 'dir-1', name: 'Compare Cloud Pricing' } as any;

    it('merges active directory providers with schedule provider overrides taking precedence', async () => {
        const scheduleRepository = {
            findByDirectoryId: jest.fn().mockResolvedValue({
                providerOverrides: { ai: 'openai', pipeline: 'agent-pipeline' },
            }),
        };
        const directoryPluginRepository = {
            findEnabledByDirectory: jest.fn().mockResolvedValue([
                {
                    pluginId: 'anthropic',
                    activeCapability: 'ai-provider',
                    pluginEntity: { manifest: {} },
                },
                {
                    pluginId: 'screenshotone',
                    activeCapability: 'screenshot',
                    pluginEntity: { manifest: {} },
                },
                {
                    pluginId: 'firecrawl',
                    activeCapability: 'content-extractor',
                    pluginEntity: { manifest: {} },
                },
            ]),
            findActiveByCapability: jest.fn().mockResolvedValue({
                settings: { model: 'openai/gpt-5.1' },
            }),
        };
        const service = new WorksConfigProjectionService(
            scheduleRepository as any,
            directoryPluginRepository as any,
        );

        await expect(service.buildWriteRequest(directory)).resolves.toEqual({
            name: 'Compare Cloud Pricing',
            model: 'openai/gpt-5.1',
            providers: {
                ai: 'openai',
                pipeline: 'agent-pipeline',
                screenshot: 'screenshotone',
                contentExtractor: 'firecrawl',
            },
        });
    });

    it('falls back to active capability providers and skips supplementary plugins', async () => {
        const scheduleRepository = {
            findByDirectoryId: jest.fn().mockResolvedValue({ providerOverrides: null }),
        };
        const directoryPluginRepository = {
            findEnabledByDirectory: jest.fn().mockResolvedValue([
                {
                    pluginId: 'openai',
                    activeCapability: 'ai-provider',
                    pluginEntity: { manifest: {} },
                },
                {
                    pluginId: 'screenshotone',
                    activeCapability: 'screenshot',
                    pluginEntity: { manifest: {} },
                },
                {
                    pluginId: 'helper-plugin',
                    activeCapability: 'search',
                    pluginEntity: { manifest: { supplementary: true } },
                },
            ]),
            findActiveByCapability: jest.fn().mockResolvedValue(null),
        };
        const service = new WorksConfigProjectionService(
            scheduleRepository as any,
            directoryPluginRepository as any,
        );

        await expect(service.buildWriteRequest(directory)).resolves.toEqual({
            name: 'Compare Cloud Pricing',
            model: undefined,
            providers: { ai: 'openai', screenshot: 'screenshotone' },
        });
    });
});
