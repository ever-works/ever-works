import { DeployFacadeService, PLATFORM_MANAGED_KUBECONFIG_SENTINEL } from '../deploy.facade';

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

    it('checks configured state for the ever-works alias against k8s settings', async () => {
        const { service, registry, settingsService } = createService({
            deployProvider: 'ever-works',
            pluginId: 'k8s',
            settings: { clusterSource: { value: 'k8s-works' } },
        });

        await expect(service.isProviderConfigured('ever-works', 'user-1', 'work-1')).resolves.toBe(
            true,
        );

        expect(registry.get).toHaveBeenCalledWith('k8s');
        expect(settingsService.getResolvedSettings).toHaveBeenCalledWith('k8s', {
            userId: 'user-1',
            workId: 'work-1',
            includeSecrets: true,
        });
    });

    it('uses the resolved plugin display name for the ever-works alias', () => {
        const { service } = createService({ deployProvider: 'ever-works', pluginId: 'k8s' });

        expect(service.resolveProviderId('ever-works')).toBe('k8s');
        expect(service.getProviderName('ever-works')).toBe('Kubernetes');
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

    describe('auto-assigned deployment domains', () => {
        const originalDomain = process.env.EVER_WORKS_DOMAIN;

        afterEach(() => {
            if (originalDomain === undefined) {
                delete process.env.EVER_WORKS_DOMAIN;
            } else {
                process.env.EVER_WORKS_DOMAIN = originalDomain;
            }
        });

        it('treats Ever Works subdomains as auto-assigned', () => {
            const { service } = createService({ deployProvider: 'k8s' });

            expect((service as any).isAutoAssignedDomain('my-site.ever.works')).toBe(true);
            expect((service as any).isAutoAssignedDomain('my-site.vercel.app')).toBe(true);
            expect((service as any).isAutoAssignedDomain('www.customer.com')).toBe(false);
        });

        it('respects EVER_WORKS_DOMAIN overrides for auto-assigned domains', () => {
            process.env.EVER_WORKS_DOMAIN = 'preview.ever.works';
            const { service } = createService({ deployProvider: 'k8s' });

            expect((service as any).isAutoAssignedDomain('my-site.preview.ever.works')).toBe(true);
            expect((service as any).isAutoAssignedDomain('my-site.ever.works')).toBe(false);
        });
    });

    describe('ever-works deploy provider alias', () => {
        it('resolves deployProvider=ever-works through the k8s plugin and settings', async () => {
            const { service, registry, settingsService } = createService({
                deployProvider: 'ever-works',
                pluginId: 'k8s',
                settings: { clusterSource: { value: 'k8s-works' } },
            });

            await expect(
                service.isConfigured({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toBe(true);

            const resolved = await service.getPluginAndTokenAndSettings({
                userId: 'user-1',
                workId: 'work-1',
            });

            expect(registry.get).toHaveBeenCalledWith('k8s');
            expect(settingsService.getResolvedSettings).toHaveBeenCalledWith('k8s', {
                userId: 'user-1',
                workId: 'work-1',
                includeSecrets: true,
            });
            expect(settingsService.getSettings).toHaveBeenCalledWith('k8s', {
                userId: 'user-1',
                workId: 'work-1',
                includeSecrets: true,
            });
            expect(resolved.plugin.id).toBe('k8s');
            expect(resolved.token).toBe(PLATFORM_MANAGED_KUBECONFIG_SENTINEL);
            expect(resolved.work.deployProvider).toBe('ever-works');
        });
    });

    describe('EW-616 platform-managed kubeconfig sentinel', () => {
        it('returns the sentinel for k8s + clusterSource=k8s-works when no kubeconfig is saved', async () => {
            const { service } = createService({
                deployProvider: 'k8s',
                settings: { clusterSource: { value: 'k8s-works' } },
            });

            await expect(
                service.getDeployToken({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toBe(PLATFORM_MANAGED_KUBECONFIG_SENTINEL);
            await expect(
                service.isConfigured({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toBe(true);
        });

        it('returns the sentinel for k8s + clusterSource=k8s-works-shared when no kubeconfig is saved', async () => {
            const { service } = createService({
                deployProvider: 'k8s',
                settings: { clusterSource: { value: 'k8s-works-shared' } },
            });

            await expect(
                service.getDeployToken({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toBe(PLATFORM_MANAGED_KUBECONFIG_SENTINEL);
        });

        it('returns the sentinel for the legacy k8s-gauzy alias (rolling-deploy defense-in-depth)', async () => {
            const { service } = createService({
                deployProvider: 'k8s',
                settings: { clusterSource: { value: 'k8s-gauzy' } },
            });

            await expect(
                service.getDeployToken({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toBe(PLATFORM_MANAGED_KUBECONFIG_SENTINEL);
        });

        it('prefers a user-pasted kubeconfig over the sentinel when both are present', async () => {
            const { service } = createService({
                deployProvider: 'k8s',
                settings: {
                    clusterSource: { value: 'k8s-works' },
                    kubeconfig: { value: 'apiVersion: v1\nkind: Config\n' },
                },
            });

            await expect(
                service.getDeployToken({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toContain('apiVersion: v1');
        });

        it('does NOT return the sentinel for clusterSource=custom-kubeconfig — back-compat path still requires a real kubeconfig', async () => {
            const { service } = createService({
                deployProvider: 'k8s',
                settings: { clusterSource: { value: 'custom-kubeconfig' } },
            });

            await expect(
                service.getDeployToken({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toBeNull();
        });

        it('does NOT return the sentinel for non-k8s plugins even with a clusterSource setting', async () => {
            const { service } = createService({
                deployProvider: 'vercel',
                pluginId: 'vercel',
                settings: { clusterSource: { value: 'k8s-works' } },
            });

            await expect(
                service.getDeployToken({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toBeNull();
        });
    });

    /**
     * EW-741 — BYO Cloudflare custom-domain reconciliation.
     *
     * When the user has saved settings for a `dns` plugin (full
     * `IDnsProvider` shape — declares all four `dns-*` capabilities) AND
     * the LB hostname env is configured, addDomain MUST call `ensureRecord`
     * on the user-scoped DNS plugin so the custom domain's DNS record is
     * created in the user's own Cloudflare zone. Failures are best-effort —
     * the request must still succeed when the plugin throws.
     *
     * The operator-managed mode (no user-scoped DNS plugin settings) must
     * stay guidance-only — `ensureRecord` is NOT called.
     */
    describe('EW-741 — addDomain BYO Cloudflare reconciliation', () => {
        const ORIGINAL_LB = process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME;

        afterEach(() => {
            if (ORIGINAL_LB === undefined) {
                delete process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME;
            } else {
                process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = ORIGINAL_LB;
            }
        });

        // Build a deploy plugin + dns plugin pair, with the domain repository
        // and a settings service whose `getSettings` returns different values
        // per plugin id (the deploy plugin's settings vs. the DNS plugin's).
        const buildAddDomainFixture = (args: {
            dnsUserSettings?: Record<string, unknown>;
            ensureRecord?: jest.Mock;
            includeDnsPlugin?: boolean;
        }) => {
            const ensureRecord =
                args.ensureRecord ??
                jest.fn().mockResolvedValue({
                    id: 'rec-1',
                    type: 'CNAME',
                    name: 'tools.example.com',
                    content: 'lb.ever.works',
                });
            const deployPlugin = {
                id: 'k8s',
                name: 'Kubernetes',
                providerName: 'kubernetes',
                capabilities: ['deployment'],
                addDomain: jest.fn().mockResolvedValue({
                    domain: { name: 'tools.example.com', verified: false },
                    verified: false,
                }),
            };
            const dnsPlugin = {
                id: 'cloudflare-dns',
                name: 'Cloudflare DNS',
                providerName: 'cloudflare',
                capabilities: [
                    'dns',
                    'dns-ensure-record',
                    'dns-remove-record',
                    'dns-record-exists',
                    'dns-root-domain',
                ],
                ensureRecord,
                removeRecord: jest.fn(),
                recordExists: jest.fn().mockResolvedValue(false),
                rootDomain: () => 'example.com',
            };
            const deployRegistered = {
                plugin: deployPlugin,
                manifest: {
                    id: 'k8s',
                    name: 'Kubernetes',
                    category: 'deployment',
                    capabilities: ['deployment'],
                    description: '',
                    icon: { type: 'lucide', value: 'Container' },
                },
                state: 'loaded',
            };
            const dnsRegistered = {
                plugin: dnsPlugin,
                manifest: {
                    id: 'cloudflare-dns',
                    name: 'Cloudflare DNS',
                    category: 'dns',
                    capabilities: dnsPlugin.capabilities,
                    description: '',
                    icon: { type: 'lucide', value: 'Cloud' },
                },
                state: 'loaded',
            };
            const includeDns = args.includeDnsPlugin ?? true;
            const registry = {
                get: jest.fn((id: string) => {
                    if (id === 'k8s') return deployRegistered;
                    if (id === 'cloudflare-dns' && includeDns) return dnsRegistered;
                    return undefined;
                }),
                getByCapability: jest.fn((cap: string) => {
                    if (cap === 'deployment') return [deployRegistered];
                    if (cap === 'dns-ensure-record' && includeDns) return [dnsRegistered];
                    return [];
                }),
            };
            const settingsService = {
                getResolvedSettings: jest
                    .fn()
                    .mockResolvedValue({ kubeconfig: { value: 'apiVersion: v1' } }),
                getSettings: jest.fn(async (pluginId: string) => {
                    if (pluginId === 'cloudflare-dns') {
                        return args.dnsUserSettings ?? {};
                    }
                    return {};
                }),
            };
            const work = {
                id: 'work-1',
                slug: 'site',
                deployProvider: 'k8s',
                user: { id: 'user-1' },
                website: 'https://site.ever.works',
                // Short-circuit `resolveProjectId` — the BYO custom-domain
                // path doesn't care what projectId resolves to; we just need
                // the addDomain pipeline to reach the DB persist + DNS hook.
                deployProjectId: 'project-1',
            };
            const workRepository = {
                findById: jest.fn().mockResolvedValue(work),
                update: jest.fn(),
            };
            const domainRepository = {
                findByWork: jest.fn().mockResolvedValue([]),
                findOne: jest.fn().mockResolvedValue(null),
                addDomain: jest.fn().mockResolvedValue({
                    workId: 'work-1',
                    domain: 'tools.example.com',
                    verified: false,
                }),
                updateVerified: jest.fn(),
                updateProvider: jest.fn(),
            };
            const service = new DeployFacadeService(
                registry as any,
                settingsService as any,
                workRepository as any,
                {} as any,
                domainRepository as any,
            );
            return { service, deployPlugin, dnsPlugin, ensureRecord, domainRepository };
        };

        it('calls ensureRecord on the user-scoped DNS plugin when BYO settings are present', async () => {
            process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'lb.ever.works';
            const { service, ensureRecord, domainRepository } = buildAddDomainFixture({
                dnsUserSettings: { apiToken: 'cf-tok', zoneId: 'zone-1', proxied: true },
            });

            await service.addDomain('tools.example.com', {
                userId: 'user-1',
                workId: 'work-1',
            });

            // Wait one microtask for the void-chained fire-and-forget.
            await new Promise((r) => setImmediate(r));

            // The custom-domain row is persisted unconditionally — BYO
            // ensureRecord is purely additive.
            expect(domainRepository.addDomain).toHaveBeenCalledWith(
                'work-1',
                'tools.example.com',
                'k8s',
            );
            expect(ensureRecord).toHaveBeenCalledTimes(1);
            expect(ensureRecord).toHaveBeenCalledWith({
                host: 'tools.example.com',
                type: 'CNAME',
                target: 'lb.ever.works',
                proxied: true,
            });
        });

        it('does NOT call ensureRecord when the user has no DNS plugin settings (operator-managed)', async () => {
            process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'lb.ever.works';
            const { service, ensureRecord, domainRepository } = buildAddDomainFixture({
                // Empty user settings = operator-managed only.
                dnsUserSettings: {},
            });

            await service.addDomain('tools.example.com', {
                userId: 'user-1',
                workId: 'work-1',
            });
            await new Promise((r) => setImmediate(r));

            expect(domainRepository.addDomain).toHaveBeenCalled();
            expect(ensureRecord).not.toHaveBeenCalled();
        });

        it('does NOT call ensureRecord when no DNS plugin is loaded', async () => {
            process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'lb.ever.works';
            const { service, ensureRecord, domainRepository } = buildAddDomainFixture({
                includeDnsPlugin: false,
                dnsUserSettings: { apiToken: 'cf-tok' },
            });

            await service.addDomain('tools.example.com', {
                userId: 'user-1',
                workId: 'work-1',
            });
            await new Promise((r) => setImmediate(r));

            expect(domainRepository.addDomain).toHaveBeenCalled();
            expect(ensureRecord).not.toHaveBeenCalled();
        });

        it('does NOT call ensureRecord when EVER_WORKS_DEPLOY_LB_HOSTNAME is unset', async () => {
            delete process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME;
            const { service, ensureRecord, domainRepository } = buildAddDomainFixture({
                dnsUserSettings: { apiToken: 'cf-tok' },
            });

            await service.addDomain('tools.example.com', {
                userId: 'user-1',
                workId: 'work-1',
            });
            await new Promise((r) => setImmediate(r));

            expect(domainRepository.addDomain).toHaveBeenCalled();
            expect(ensureRecord).not.toHaveBeenCalled();
        });

        it('swallows ensureRecord failures (the request still succeeds)', async () => {
            process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'lb.ever.works';
            const failing = jest.fn().mockRejectedValue(new Error('cf api 5xx'));
            const { service, domainRepository } = buildAddDomainFixture({
                dnsUserSettings: { apiToken: 'cf-tok' },
                ensureRecord: failing,
            });

            await expect(
                service.addDomain('tools.example.com', {
                    userId: 'user-1',
                    workId: 'work-1',
                }),
            ).resolves.toMatchObject({ verified: false });
            await new Promise((r) => setImmediate(r));

            expect(domainRepository.addDomain).toHaveBeenCalled();
            expect(failing).toHaveBeenCalled();
        });
    });

    /**
     * Task 10 — the managed `ever-works` deploy provider sources its kubeconfig
     * from platform env, NOT from the user's k8s settings. The infra owner
     * decides Path A vs Path B purely by which env var they provision:
     *   - Path A: `EVER_WORKS_DEPLOY_*` (dedicated cluster, via the provider).
     *   - Path B: `EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG` (shared cluster).
     * When neither is set, resolution gracefully keeps the existing
     * sentinel/user-kubeconfig behaviour (never crashes).
     */
    describe('Task 10 — managed ever-works kubeconfig resolution (Path A + Path B)', () => {
        const ORIGINAL_SHARED = process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG;
        afterEach(() => {
            if (ORIGINAL_SHARED === undefined) {
                delete process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG;
            } else {
                process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG = ORIGINAL_SHARED;
            }
        });

        const build = (args: {
            everWorks: { isEnabled: () => boolean; resolveKubeconfig?: jest.Mock };
            settings?: Record<string, { value?: unknown }>;
        }) => {
            const plugin = {
                id: 'k8s',
                name: 'Kubernetes',
                providerName: 'kubernetes',
                capabilities: ['deployment'],
            };
            const registered = {
                plugin,
                manifest: {
                    id: 'k8s',
                    name: 'Kubernetes',
                    category: 'deployment',
                    capabilities: ['deployment'],
                    description: '',
                    icon: { type: 'lucide', value: 'Container' },
                },
                state: 'loaded',
            };
            const registry = {
                get: jest.fn((id: string) => (id === 'k8s' ? registered : undefined)),
                getByCapability: jest.fn(() => [registered]),
            };
            const settingsService = {
                getResolvedSettings: jest.fn().mockResolvedValue(args.settings ?? {}),
                getSettings: jest.fn().mockResolvedValue({}),
            };
            const workRepository = {
                findById: jest
                    .fn()
                    .mockResolvedValue({ id: 'work-1', deployProvider: 'ever-works' }),
                update: jest.fn(),
            };
            const domainRepository = { findByWork: jest.fn().mockResolvedValue([]) };
            const service = new DeployFacadeService(
                registry as any,
                settingsService as any,
                workRepository as any,
                {} as any,
                domainRepository as any,
                undefined,
                args.everWorks as any,
            );
            return { service };
        };

        it('Path A — uses the dedicated cluster kubeconfig from EverWorksK8sDeployProvider when enabled', async () => {
            const resolveKubeconfig = jest.fn().mockResolvedValue('dedicated-kubeconfig');
            const { service } = build({ everWorks: { isEnabled: () => true, resolveKubeconfig } });

            const resolved = await service.getPluginAndTokenAndSettings({
                userId: 'user-1',
                workId: 'work-1',
            });

            expect(resolveKubeconfig).toHaveBeenCalledTimes(1);
            expect(resolved.plugin.id).toBe('k8s');
            expect(resolved.token).toBe('dedicated-kubeconfig');
        });

        it('Path B — falls back to EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG when the dedicated provider is disabled', async () => {
            process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG = 'shared-cluster-kubeconfig';
            const resolveKubeconfig = jest.fn();
            const { service } = build({ everWorks: { isEnabled: () => false, resolveKubeconfig } });

            const resolved = await service.getPluginAndTokenAndSettings({
                userId: 'user-1',
                workId: 'work-1',
            });

            // Dedicated provider is disabled → never consulted for a kubeconfig.
            expect(resolveKubeconfig).not.toHaveBeenCalled();
            expect(resolved.token).toBe('shared-cluster-kubeconfig');
        });

        it('gracefully keeps the platform-managed sentinel when neither managed cluster is configured', async () => {
            delete process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG;
            const { service } = build({
                everWorks: { isEnabled: () => false },
                settings: { clusterSource: { value: 'k8s-works' } },
            });

            const resolved = await service.getPluginAndTokenAndSettings({
                userId: 'user-1',
                workId: 'work-1',
            });

            expect(resolved.token).toBe(PLATFORM_MANAGED_KUBECONFIG_SENTINEL);
        });
    });
});
