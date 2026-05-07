import { DeployFacadeService } from '../deploy.facade';

describe('DeployFacadeService', () => {
    const createService = (args: {
        deployProvider?: string;
        settings?: Record<string, { value?: unknown }>;
        pluginId?: string;
        pluginName?: string;
    }) => {
        const pluginId = args.pluginId ?? args.deployProvider ?? 'k8s';
        const plugin = {
            id: pluginId,
            name: args.pluginName ?? 'Kubernetes',
            providerName: 'kubernetes',
            capabilities: ['deployment'],
        };
        const registered = {
            plugin,
            manifest: {
                id: pluginId,
                name: plugin.name,
                category: 'deployment',
                capabilities: ['deployment'],
                description: 'Deploy provider',
                icon: { type: 'lucide', value: 'Container' },
            },
            state: 'loaded',
        };
        const registry = {
            get: jest.fn((id: string) => (id === pluginId ? registered : undefined)),
            getByCapability: jest.fn(() => [registered]),
        };
        const settingsService = {
            getResolvedSettings: jest.fn().mockResolvedValue(args.settings ?? {}),
            getSettings: jest.fn().mockResolvedValue({}),
        };
        const workRepository = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                deployProvider: args.deployProvider ?? pluginId,
            }),
            update: jest.fn(),
        };
        const domainRepository = {
            findByWork: jest.fn().mockResolvedValue([]),
        };

        const service = new DeployFacadeService(
            registry as any,
            settingsService as any,
            workRepository as any,
            {} as any,
            domainRepository as any,
        );

        return { service, registry, settingsService, workRepository };
    };

    it('treats Kubernetes kubeconfig as the deployment credential', async () => {
        const { service } = createService({
            deployProvider: 'k8s',
            settings: { kubeconfig: { value: 'apiVersion: v1\nkind: Config\n' } },
        });

        await expect(service.isConfigured({ userId: 'user-1', workId: 'work-1' })).resolves.toBe(
            true,
        );
        await expect(
            service.getDeployToken({ userId: 'user-1', workId: 'work-1' }),
        ).resolves.toContain('apiVersion: v1');
    });

    it('reports configured state per provider for provider-list UI', async () => {
        const { service } = createService({
            deployProvider: 'k8s',
            settings: { kubeconfig: { value: 'apiVersion: v1\nkind: Config\n' } },
        });

        const providers = await service.getAvailableProvidersForUser('user-1');

        expect(providers).toMatchObject([
            {
                id: 'k8s',
                name: 'Kubernetes',
                enabled: true,
                configured: true,
            },
        ]);
    });

    it('does not report an unconfigured loaded provider as configured', async () => {
        const { service } = createService({
            deployProvider: 'k8s',
            settings: {},
        });

        const providers = await service.getAvailableProvidersForUser('user-1');

        expect(providers[0]).toMatchObject({
            id: 'k8s',
            enabled: true,
            configured: false,
        });
    });
});
