import { WorksConfigProjectionService } from '../services/works-config-projection.service';

describe('WorksConfigProjectionService', () => {
    const work = { id: 'dir-1', name: 'Compare Cloud Pricing' } as any;

    it('merges active work providers with schedule provider overrides taking precedence', async () => {
        const scheduleRepository = {
            findByWorkId: jest.fn().mockResolvedValue({
                providerOverrides: { ai: 'openai', pipeline: 'agent-pipeline' },
            }),
        };
        const workPluginRepository = {
            findEnabledByWork: jest.fn().mockResolvedValue([
                {
                    pluginId: 'anthropic',
                    activeCapabilities: ['ai-provider'],
                    pluginEntity: { manifest: {} },
                },
                {
                    pluginId: 'screenshotone',
                    activeCapabilities: ['screenshot'],
                    pluginEntity: { manifest: {} },
                },
                {
                    pluginId: 'firecrawl',
                    activeCapabilities: ['content-extractor'],
                    pluginEntity: { manifest: {} },
                },
            ]),
            findActiveByCapability: jest.fn().mockResolvedValue({
                settings: { model: 'openai/gpt-5.1' },
            }),
        };
        const service = new WorksConfigProjectionService(
            scheduleRepository as any,
            workPluginRepository as any,
        );

        await expect(service.buildWriteRequest(work)).resolves.toEqual({
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
            findByWorkId: jest.fn().mockResolvedValue({ providerOverrides: null }),
        };
        const workPluginRepository = {
            findEnabledByWork: jest.fn().mockResolvedValue([
                {
                    pluginId: 'openai',
                    activeCapabilities: ['ai-provider'],
                    pluginEntity: { manifest: {} },
                },
                {
                    pluginId: 'screenshotone',
                    activeCapabilities: ['screenshot'],
                    pluginEntity: { manifest: {} },
                },
                {
                    pluginId: 'helper-plugin',
                    activeCapabilities: ['search'],
                    pluginEntity: { manifest: { supplementary: true } },
                },
            ]),
            findActiveByCapability: jest.fn().mockResolvedValue(null),
        };
        const service = new WorksConfigProjectionService(
            scheduleRepository as any,
            workPluginRepository as any,
        );

        await expect(service.buildWriteRequest(work)).resolves.toEqual({
            name: 'Compare Cloud Pricing',
            model: null,
            providers: { ai: 'openai', screenshot: 'screenshotone' },
        });
    });

    it('returns an explicit providers clear signal when no providers are active', async () => {
        const scheduleRepository = {
            findByWorkId: jest.fn().mockResolvedValue({ providerOverrides: null }),
        };
        const workPluginRepository = {
            findEnabledByWork: jest.fn().mockResolvedValue([]),
            findActiveByCapability: jest.fn().mockResolvedValue(null),
        };
        const service = new WorksConfigProjectionService(
            scheduleRepository as any,
            workPluginRepository as any,
        );

        await expect(service.buildWriteRequest(work)).resolves.toEqual({
            name: 'Compare Cloud Pricing',
            model: null,
            providers: null,
        });
    });
});
