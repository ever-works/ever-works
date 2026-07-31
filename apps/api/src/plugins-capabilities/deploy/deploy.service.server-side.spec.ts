jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class {},
    WorkCustomDomainRepository: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    Work: class {},
    User: class {},
    DeploymentEnvironment: { PRODUCTION: 'production', PREVIEW: 'preview' },
    DeploymentTriggerSource: {
        MANUAL: 'manual',
        SCHEDULED: 'scheduled',
    },
}));
jest.mock('@ever-works/agent/plugins', () => ({ PluginRegistryService: class {} }));
jest.mock('@ever-works/agent/services', () => ({
    PlatformSyncSecretService: class {},
    ZeroFrictionFunnelService: class {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    DeployFacadeService: class {},
    GitFacadeService: class {},
}));
jest.mock('@ever-works/agent/generators', () => ({
    WebsiteUpdateService: class {},
    getWebsiteTemplateBranch: () => 'main',
    getWebsiteTemplateConfig: () => ({ branch: 'main' }),
}));
jest.mock('@ever-works/agent/events', () => ({
    DeploymentDispatchedEvent: class {
        static EVENT_NAME = 'deployment.dispatched';
        constructor(public readonly payload: unknown) {}
    },
}));

import { DeployService } from './deploy.service';

/**
 * Tests focused on the capability-driven contract changes:
 *
 *  - DeployService now calls `plugin.getWorkflowFilenames()` instead of
 *    using a hardcoded list, so each plugin owns its own dispatch surface.
 *  - DeployService now calls `plugin.getDeploymentSecrets(settings)` after
 *    pushing the standard secrets, so plugins (k8s especially) can
 *    contribute extra GitHub Actions secrets without touching this service.
 *
 * The non-network methods (`setActionSecret`, `setActionVariable`,
 * `dispatchWorkflow`, `getRepositoryPublicKey`, `enableDeploymentWorkflows`)
 * are stubbed via the `pluginRegistry` mock so we never touch a real GitHub.
 */
/**
 * EW — server-side deploy for platform-managed cluster tiers.
 *
 * The GitHub Actions deploy path cannot reach a platform-managed cluster
 * (ARC runner pods have no egress to the cluster APIs; customer repos run on
 * GitHub-hosted runners that can never reach a private RFC1918 endpoint), so
 * DeployService now applies manifests server-side via
 * KubernetesPlugin.deploy() when the work targets `k8s-works` /
 * `k8s-works-shared` — and, critically, STOPS writing the platform
 * kubeconfig to the website repo, honouring the documented contract for the
 * customer default: "No cluster credentials to manage; the platform runs it
 * for you." `custom-kubeconfig` (bring-your-own cluster, incl. forks) keeps
 * the workflow-dispatch path byte-identical.
 *
 * The DI harness below is the one from deploy.service.spec.ts, copied
 * verbatim so constructor-arg order can never drift between the two files.
 */
describe('DeployService — server-side deploy for managed cluster tiers', () => {
    const buildService = (overrides: {
        plugin: Record<string, unknown>;
        token?: string;
        settings?: Record<string, unknown>;
        deployProvider?: string;
        /** Owner returned by `work.getRepoOwner('website')`. Defaults to
         *  the customer-owned org `'acme'` so most tests run on the
         *  permissive EW-616 cell. Tests that exercise the platform-owned
         *  orgs override this. */
        websiteOwner?: string;
        /** Settings returned by deployFacade.getOtherPluginSettings('github', ...).
         *  Defaults to an empty object (no PAT saved). Tests for the GHCR PAT
         *  flow override this with `{ readPackagesPat: '...' }`. */
        githubPluginSettings?: Record<string, unknown>;
        /** EW-120 dual-mode Activity Feed sync. Defaults to `push` to keep
         *  pre-dual-mode tests behaving as before. */
        activitySyncMode?: 'pull' | 'push' | 'disabled';
        githubPluginOverrides?: Record<string, unknown>;
        /** Work's public `website` URL — drives the per-Work k8s Ingress host. */
        website?: string;
        /** Whether the Work owner is a platform admin — gates `k8s-works`. */
        isPlatformAdmin?: boolean;
    }) => {
        const websiteOwner = overrides.websiteOwner ?? 'acme';
        const work = {
            id: 'work-1',
            slug: 'my-site',
            website: overrides.website,
            deployProvider: overrides.deployProvider ?? 'k8s',
            gitProvider: 'github',
            websiteTemplateId: 'directory-web-template',
            activitySyncMode: overrides.activitySyncMode ?? 'push',
            user: { id: 'user-1', isPlatformAdmin: overrides.isPlatformAdmin ?? false },
            getRepoOwner: () => websiteOwner,
            getDataRepo: () => `${websiteOwner}/data`,
            getWebsiteRepo: () => `${websiteOwner}-site`,
            resolveCommitter: () => ({ name: 'a', email: 'a@b' }),
        };

        const deployFacade = {
            getPluginAndTokenAndSettings: jest.fn().mockResolvedValue({
                plugin: overrides.plugin,
                token: overrides.token ?? 'kubeconfig:::yaml',
                work,
                settings: overrides.settings ?? {},
            }),
            getOtherPluginSettings: jest
                .fn()
                .mockResolvedValue(overrides.githubPluginSettings ?? {}),
        };

        const gitFacade = {
            getAccessToken: jest.fn().mockResolvedValue('gh-token'),
        };

        const workRepository = {
            findById: jest.fn().mockResolvedValue(work),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const deploymentRepository = {
            create: jest.fn().mockResolvedValue({ id: 'deployment-1' }),
            markTerminal: jest.fn().mockResolvedValue(undefined),
        };

        // Single shared GitHub plugin stub returned by every
        // pluginRegistry.get('github') call. Capturing its call history is
        // what tests assert against.
        const githubPlugin = {
            setActionSecret: jest.fn().mockResolvedValue(undefined),
            setActionVariable: jest.fn().mockResolvedValue(undefined),
            dispatchWorkflow: jest.fn().mockResolvedValue(undefined),
            getRepositoryPublicKey: jest.fn().mockResolvedValue({ key_id: 'k', key: 'pubkey' }),
            enableDeploymentWorkflows: jest.fn().mockResolvedValue(undefined),
            ...(overrides.githubPluginOverrides ?? {}),
        };

        const pluginRegistry = {
            get: jest.fn(() => ({
                plugin: githubPlugin,
                state: 'loaded',
                manifest: { capabilities: ['git-provider'] },
            })),
        };

        const websiteUpdateService = {
            updateRepository: jest.fn().mockResolvedValue(undefined),
        };

        const websiteTemplateResolver = {
            resolveForWork: jest.fn().mockResolvedValue({ branch: 'main' }),
        };

        const eventEmitter = {
            emit: jest.fn(),
        };

        const platformSyncSecretService = {
            getOrGenerate: jest.fn().mockResolvedValue('hex'.repeat(21) + 'h'), // 64 hex chars
        };

        // Same per-Work-persistent shape as PlatformSyncSecretService.
        const webhookSecretService = {
            getOrGenerate: jest.fn().mockResolvedValue('webhook'.repeat(9) + 'a'), // 64 chars
        };

        const workRuntimeEnvService = {
            getOrGenerateAuthSecret: jest.fn().mockResolvedValue('auth-secret-base64'),
            getOrGenerateCookieSecret: jest.fn().mockResolvedValue('cookie-secret-base64'),
            getDatabaseUrl: jest.fn().mockResolvedValue(null),
        };

        // EW-617 G5: DNS automation no-ops in tests (no env vars). The
        // dns service still needs to be present so the constructor wires
        // — `getProvider` returns null and `ensureWorkSubdomain` is a
        // safe stub.
        const dnsService = {
            getProvider: jest.fn(() => null),
            ingressHostFor: jest.fn((slug: string) => `${slug}.ever.works`),
            ensureWorkSubdomain: jest.fn().mockResolvedValue(undefined),
            removeWorkSubdomain: jest.fn().mockResolvedValue(undefined),
        };

        // EW-617 G8: funnel emit sink — no-op stub by default.
        const funnel = { emit: jest.fn() };

        // EW-734 / EW-737 — collision-safe allocator. Tests that exercise the
        // gated managed-subdomain path stub `allocate`; the default no-op
        // keeps the legacy + EW-741 paths working without forcing every test
        // to wire it explicitly.
        const subdomainAllocator = {
            allocate: jest.fn().mockResolvedValue({
                subdomain: 'allocated',
                fqdn: 'allocated.ever.works',
                rootDomain: 'ever.works',
                allocated: true,
            }),
        };

        // EW-741 — `WorkCustomDomain` rows for this Work. Default = none, so
        // most tests see no `extraHosts` in the merged settings. Tests that
        // exercise reconciliation override `findByWork` to return rows.
        const customDomainRepository = {
            findByWork: jest.fn().mockResolvedValue([]),
        };

        const service = new DeployService(
            deployFacade as any,
            gitFacade as any,
            workRepository as any,
            deploymentRepository as any,
            pluginRegistry as any,
            websiteUpdateService as any,
            websiteTemplateResolver as any,
            eventEmitter as any,
            platformSyncSecretService as any,
            webhookSecretService as any,
            workRuntimeEnvService as any,
            dnsService as any,
            subdomainAllocator as any,
            funnel as any,
            customDomainRepository as any,
        );

        return {
            service,
            work,
            deployFacade,
            gitFacade,
            deploymentRepository,
            pluginRegistry,
            githubPlugin,
            eventEmitter,
            platformSyncSecretService,
            webhookSecretService,
            dnsService,
            funnel,
            subdomainAllocator,
            customDomainRepository,
        };
    };

    const SHARED_KC = 'shared-cluster-kubeconfig-yaml';
    const managedPlugin = () => ({
        id: 'k8s',
        deploy: jest.fn().mockResolvedValue({ status: 'deploying', id: 'd', createdAt: 't' }),
        getWorkflowFilenames: () => ['deploy_k8s.yaml'],
        getDeploymentSecrets: jest.fn().mockResolvedValue({ K8S_NAMESPACE: 'ns' }),
    });

    beforeEach(() => {
        process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG = SHARED_KC;
    });
    afterEach(() => {
        delete process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG;
    });

    it('managed tier → plugin.deploy applies server-side with the platform kubeconfig', async () => {
        const plugin = managedPlugin();
        const { service, githubPlugin } = buildService({
            plugin,
            settings: { clusterSource: 'k8s-works-shared' },
        });

        const result = await service.deploy('work-1', 'user-1');

        expect(result.dispatched).toBe(true);
        expect(plugin.deploy).toHaveBeenCalledTimes(1);
        const [config, kubeconfig] = plugin.deploy.mock.calls[0];
        expect(kubeconfig).toBe(SHARED_KC);
        expect(config.projectName).toBe('my-site');
        expect(config.options.imageName).toBe('acme-site');
        expect(config.options.githubOwner).toBe('acme');
        // No workflow dispatch on the managed path.
        expect(githubPlugin.dispatchWorkflow).not.toHaveBeenCalled();
    });

    it('managed tier → the platform kubeconfig is NEVER written to the repo', async () => {
        const plugin = managedPlugin();
        const { service, githubPlugin } = buildService({
            plugin,
            settings: { clusterSource: 'k8s-works-shared' },
        });

        await service.deploy('work-1', 'user-1');

        // setActionSecret({ key, value, owner, repo }, publicKey, token) — the
        // secret NAME is a field of the first argument, not a positional arg.
        const pushedNames = githubPlugin.setActionSecret.mock.calls.map(
            (c: unknown[]) => (c[0] as { key: string }).key,
        );
        const pushedPairs = githubPlugin.setActionSecret.mock.calls.map((c: unknown[]) =>
            JSON.stringify(c),
        );
        expect(pushedPairs.join(' | ')).not.toContain(SHARED_KC);
        expect(pushedNames).not.toContain('K8S_TOKEN');
        expect(pushedNames).not.toContain('DEPLOY_TOKEN');
        // Everything non-credential still pushes (CI builds keep working).
        expect(pushedNames).toContain('WORK_ID');
    });

    it('managed tier → branch alias image tag (main → prod)', async () => {
        const plugin = managedPlugin();
        const { service } = buildService({
            plugin,
            settings: { clusterSource: 'k8s-works-shared' },
        });

        await service.deploy('work-1', 'user-1');

        const [config] = plugin.deploy.mock.calls[0];
        expect(config.options.gitSha).toBe('prod');
    });

    it('managed tier → alias even when a commit SHA is supplied (tag must exist)', async () => {
        // Regression guard. `k8s-build.yml` publishes only `:<alias>` and
        // `:sha-<full-sha>`; the bare short-SHA tag came from `deploy_k8s.yaml`,
        // which is now gated off. Pinning a short SHA here would reference a
        // tag that does not exist and park the pod in ImagePullBackOff.
        const plugin = managedPlugin();
        const { service } = buildService({
            plugin,
            settings: { clusterSource: 'k8s-works-shared' },
        });

        await service.deploy('work-1', 'user-1', {
            commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        });

        const [config] = plugin.deploy.mock.calls[0];
        expect(config.options.gitSha).toBe('prod');
        expect(config.options.gitSha).not.toContain('abcdef');
    });

    it('managed tier → plugin error marks the deployment terminal and reports failure', async () => {
        const plugin = managedPlugin();
        plugin.deploy.mockResolvedValue({
            status: 'error',
            error: 'boom',
            id: 'd',
            createdAt: 't',
        });
        const { service, deploymentRepository } = buildService({
            plugin,
            settings: { clusterSource: 'k8s-works-shared' },
        });

        const result = await service.deploy('work-1', 'user-1');

        expect(result.dispatched).toBe(false);
        expect(deploymentRepository.markTerminal).toHaveBeenCalledWith(
            'deployment-1',
            'ERROR',
            expect.objectContaining({ lastError: 'boom' }),
        );
    });

    it('custom-kubeconfig → workflow dispatch unchanged, plugin.deploy never called', async () => {
        const plugin = managedPlugin();
        const { service, githubPlugin } = buildService({
            plugin,
            settings: { clusterSource: 'custom-kubeconfig' },
        });

        await service.deploy('work-1', 'user-1');

        expect(plugin.deploy).not.toHaveBeenCalled();
        expect(githubPlugin.dispatchWorkflow).toHaveBeenCalled();
        // setActionSecret({ key, value, owner, repo }, publicKey, token) — the
        // secret NAME is a field of the first argument, not a positional arg.
        const pushedNames = githubPlugin.setActionSecret.mock.calls.map(
            (c: unknown[]) => (c[0] as { key: string }).key,
        );
        expect(pushedNames).toContain('K8S_TOKEN');
    });
});
