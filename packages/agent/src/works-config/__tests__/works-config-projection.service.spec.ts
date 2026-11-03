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
            activitySyncMode: null,
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
            activitySyncMode: null,
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
            activitySyncMode: null,
        });
    });

    it('projects work.deployProvider onto the write request when set (EW-612)', async () => {
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
        const workWithProvider = { ...work, deployProvider: 'k8s' };

        await expect(service.buildWriteRequest(workWithProvider)).resolves.toEqual({
            name: 'Compare Cloud Pricing',
            model: null,
            providers: null,
            deployProvider: 'k8s',
            activitySyncMode: null,
        });
    });

    it('omits deployProvider when the Work row has none, so the data repo keeps its value (EW-612)', async () => {
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

        // `undefined` (not `null`): `null` is the writer's explicit CLEAR
        // signal and would strip a provider the user declared by hand in
        // `.works/works.yml`.
        const request = await service.buildWriteRequest({ ...work, deployProvider: null } as any);
        expect(request.deployProvider).toBeUndefined();
        expect(request).not.toHaveProperty('deployProvider', null);
    });

    it('projects work.activitySyncMode onto the write request when set (EW-120)', async () => {
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
        const workWithMode = { ...work, activitySyncMode: 'push' as const };

        await expect(service.buildWriteRequest(workWithMode)).resolves.toEqual({
            name: 'Compare Cloud Pricing',
            model: null,
            providers: null,
            activitySyncMode: 'push',
        });
    });
});
