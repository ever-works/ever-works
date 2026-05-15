/**
 * EW-616 end-to-end integration test for the k8s deploy pipeline.
 *
 * Unlike the unit `deploy.service.spec.ts` (which fakes the k8s
 * plugin in addition to the agent facades), this wires:
 *
 *   - A REAL `KubernetesPlugin` instance — so its real
 *     `coerceSettings`, schema, and `getDeploymentSecrets` run.
 *   - The REAL `cluster-source-matrix.ts` validator + env-var
 *     resolver (no mocks for those).
 *   - The REAL `DeployService.resolveDeployToken` orchestration.
 *
 * The agent's `DeployFacadeService` is still faked because its
 * module graph pulls in TypeORM `@InjectRepository` decorators that
 * blow up at module-load time without a Nest TestingModule. The
 * facade's sentinel behaviour is already covered by
 * `packages/agent/src/facades/__tests__/deploy.facade.spec.ts`;
 * here we verify the **other side** of the seam — that
 * DeployService consumes the facade's contract correctly through
 * the real plugin instance, the real matrix code, and the real
 * env-var substitution.
 */

import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

jest.mock('@ever-works/agent/database', () => ({ WorkRepository: class {} }));
jest.mock('@ever-works/agent/entities', () => ({ Work: class {}, User: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({ PluginRegistryService: class {} }));
jest.mock('@ever-works/agent/services', () => ({ PlatformSyncSecretService: class {} }));
jest.mock('@ever-works/agent/facades', () => ({
    DeployFacadeService: class {},
    GitFacadeService: class {},
    PLATFORM_MANAGED_KUBECONFIG_SENTINEL: '__ever-works-platform-managed-kubeconfig__',
}));
jest.mock('@ever-works/agent/generators', () => ({
    WebsiteUpdateService: class {},
    getWebsiteTemplateBranch: () => 'main',
    WebsiteTemplateResolverService: class {},
}));
jest.mock('@ever-works/agent/events', () => ({
    DeploymentDispatchedEvent: class {
        static EVENT_NAME = 'deployment.dispatched';
        constructor(public readonly payload: unknown) {}
    },
}));

import { KubernetesPlugin } from '@ever-works/k8s-plugin';

import { DeployService } from './deploy.service';

const SENTINEL = '__ever-works-platform-managed-kubeconfig__';

describe('EW-616 deploy pipeline — real KubernetesPlugin + real matrix + real env-var substitution', () => {
    const buildHarness = (opts: {
        websiteOwner: string;
        userSettings: Record<string, unknown>;
        env?: NodeJS.ProcessEnv;
        /** Token that `DeployFacade.getPluginAndTokenAndSettings` would
         *  return for this Work. Defaults to whatever's in
         *  `userSettings.kubeconfig`, or the EW-616 sentinel when the
         *  user picked a platform-managed source without a saved
         *  kubeconfig. */
        facadeToken?: string;
    }) => {
        // The real k8s plugin — its coerceSettings + getDeploymentSecrets
        // are exercised through DeployService.setRequiredSecrets.
        const k8sPlugin = new KubernetesPlugin();

        // Decide what token the (mocked) facade would have produced for
        // this combination, matching the real facade's logic.
        const kubeconfig = opts.userSettings.kubeconfig as string | undefined;
        const clusterSource = opts.userSettings.clusterSource as string | undefined;
        const facadeToken =
            opts.facadeToken ??
            (clusterSource === 'k8s-works' || clusterSource === 'k8s-gauzy'
                ? kubeconfig || SENTINEL
                : kubeconfig || '');

        const deployFacade = {
            getPluginAndTokenAndSettings: jest.fn().mockResolvedValue({
                plugin: k8sPlugin,
                token: facadeToken,
                work: undefined, // filled in below via closure
                settings: { ...opts.userSettings },
            }),
            getOtherPluginSettings: jest.fn().mockResolvedValue({}),
        };

        const gitFacade = {
            getAccessToken: jest.fn().mockResolvedValue('gh-token'),
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
            add: jest.fn(),
            commit: jest.fn(),
            push: jest.fn(),
        };

        const work = {
            id: 'work-1',
            slug: 'my-site',
            deployProvider: 'k8s',
            gitProvider: 'github',
            user: { id: 'user-1', username: 'evereq' },
            getRepoOwner: () => opts.websiteOwner,
            getDataRepo: () => `${opts.websiteOwner}/data`,
            getWebsiteRepo: () => `${opts.websiteOwner}-site`,
            resolveCommitter: () => ({ name: 'a', email: 'a@b' }),
        };
        deployFacade.getPluginAndTokenAndSettings.mockResolvedValue({
            plugin: k8sPlugin,
            token: facadeToken,
            work,
            settings: { ...opts.userSettings },
        });

        const githubPlugin = {
            setActionSecret: jest.fn().mockResolvedValue(undefined),
            setActionVariable: jest.fn().mockResolvedValue(undefined),
            dispatchWorkflow: jest.fn().mockResolvedValue(undefined),
            getRepositoryPublicKey: jest.fn().mockResolvedValue({ key_id: 'k', key: 'pubkey' }),
            enableDeploymentWorkflows: jest.fn().mockResolvedValue(undefined),
        };
        const pluginRegistry = {
            get: jest.fn(() => ({
                plugin: githubPlugin,
                state: 'loaded',
                manifest: { capabilities: ['git-provider'] },
            })),
        };

        const workRepository = { findById: jest.fn().mockResolvedValue(work) };
        const websiteUpdateService = {
            updateRepository: jest.fn().mockResolvedValue(undefined),
        };
        const websiteTemplateResolver = {
            resolveForWork: jest.fn().mockResolvedValue({ branch: 'main' }),
        };
        const eventEmitter = new EventEmitter2();
        const platformSyncSecretService = {
            getOrGenerate: jest.fn().mockResolvedValue('platform-sync-secret'),
        };
        // 9th DI arg added on develop post-EW-616 — Ever Works DNS service.
        // No deploy path under test reaches it, so a typeless stub is fine.
        const dnsService = {};

        const prevEnv = { ...process.env };
        delete process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG;
        delete process.env.EVER_WORKS_K8S_GAUZY_KUBECONFIG;
        Object.assign(process.env, opts.env ?? {});

        const service = new DeployService(
            deployFacade as any,
            gitFacade as any,
            workRepository as any,
            pluginRegistry as any,
            websiteUpdateService as any,
            websiteTemplateResolver as any,
            eventEmitter,
            platformSyncSecretService as any,
            dnsService as any,
        );

        const restoreEnv = () => {
            process.env = prevEnv;
        };

        const capturedSecrets = () =>
            githubPlugin.setActionSecret.mock.calls.map((c: any[]) => c[0]);

        return { service, k8sPlugin, capturedSecrets, restoreEnv };
    };

    afterEach(() => {
        delete process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG;
        delete process.env.EVER_WORKS_K8S_GAUZY_KUBECONFIG;
    });

    it('ever-works-cloud Work + clusterSource=k8s-works (sentinel from facade) → env kubeconfig pushed as K8S_TOKEN, sentinel never leaks', async () => {
        const { service, capturedSecrets, restoreEnv } = buildHarness({
            websiteOwner: 'ever-works-cloud',
            userSettings: { clusterSource: 'k8s-works' /* no kubeconfig */ },
            env: { EVER_WORKS_K8S_WORKS_KUBECONFIG: 'platform-cluster-yaml' },
        });

        try {
            await service.deploy('work-1', 'user-1', {});
            const secrets = capturedSecrets();
            const k8sToken = secrets.find((s: any) => s.key === 'K8S_TOKEN');
            expect(k8sToken?.value).toBe('platform-cluster-yaml');
            for (const s of secrets) {
                expect(s.value).not.toBe(SENTINEL);
            }
        } finally {
            restoreEnv();
        }
    });

    it('ever-works Work + clusterSource=k8s-gauzy → admin path uses EVER_WORKS_K8S_GAUZY_KUBECONFIG', async () => {
        const { service, capturedSecrets, restoreEnv } = buildHarness({
            websiteOwner: 'ever-works',
            userSettings: { clusterSource: 'k8s-gauzy' },
            env: { EVER_WORKS_K8S_GAUZY_KUBECONFIG: 'internal-cluster-yaml' },
        });
        try {
            await service.deploy('work-1', 'user-1', {});
            const k8sToken = capturedSecrets().find((s: any) => s.key === 'K8S_TOKEN');
            expect(k8sToken?.value).toBe('internal-cluster-yaml');
        } finally {
            restoreEnv();
        }
    });

    it('ever-works-cloud Work + clusterSource=custom-kubeconfig → 400 BadRequest with cell-C explanation', async () => {
        const { service, restoreEnv } = buildHarness({
            websiteOwner: 'ever-works-cloud',
            userSettings: { clusterSource: 'custom-kubeconfig', kubeconfig: 'user-yaml' },
        });
        try {
            await expect(service.deploy('work-1', 'user-1', {})).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.deploy('work-1', 'user-1', {})).rejects.toThrow(
                /cross-tenant exposure/i,
            );
        } finally {
            restoreEnv();
        }
    });

    it('customer-owned Work + clusterSource=k8s-gauzy → 400 BadRequest (admin-only cluster)', async () => {
        const { service, restoreEnv } = buildHarness({
            websiteOwner: 'acme',
            userSettings: { clusterSource: 'k8s-gauzy' },
        });
        try {
            await expect(service.deploy('work-1', 'user-1', {})).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.deploy('work-1', 'user-1', {})).rejects.toThrow(
                /'k8s-gauzy' is the Ever Works internal platform cluster/,
            );
        } finally {
            restoreEnv();
        }
    });

    it('clusterSource=k8s-works but platform env var missing → 500 InternalServerError', async () => {
        const { service, restoreEnv } = buildHarness({
            websiteOwner: 'ever-works-cloud',
            userSettings: { clusterSource: 'k8s-works' },
            // intentionally no env
        });
        try {
            await expect(service.deploy('work-1', 'user-1', {})).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );
            await expect(service.deploy('work-1', 'user-1', {})).rejects.toThrow(
                /EVER_WORKS_K8S_WORKS_KUBECONFIG is not configured/,
            );
        } finally {
            restoreEnv();
        }
    });

    it('back-compat: customer-owned Work, no clusterSource, valid pasted kubeconfig → K8S_TOKEN is the user kubeconfig', async () => {
        const { service, capturedSecrets, restoreEnv } = buildHarness({
            websiteOwner: 'acme',
            userSettings: { kubeconfig: 'apiVersion: v1\nkind: Config\nclusters: []\n' },
        });
        try {
            await service.deploy('work-1', 'user-1', {});
            const k8sToken = capturedSecrets().find((s: any) => s.key === 'K8S_TOKEN');
            expect(k8sToken?.value).toContain('apiVersion: v1');
        } finally {
            restoreEnv();
        }
    });

    it('real KubernetesPlugin contributes K8S_CLUSTER_SOURCE reflecting user choice', async () => {
        const { service, capturedSecrets, restoreEnv } = buildHarness({
            websiteOwner: 'ever-works-cloud',
            userSettings: { clusterSource: 'k8s-works' },
            env: { EVER_WORKS_K8S_WORKS_KUBECONFIG: 'platform-yaml' },
        });
        try {
            await service.deploy('work-1', 'user-1', {});
            const cs = capturedSecrets().find((s: any) => s.key === 'K8S_CLUSTER_SOURCE');
            expect(cs?.value).toBe('k8s-works');
        } finally {
            restoreEnv();
        }
    });

    it('real KubernetesPlugin contributes K8S_NAMESPACE default when not configured', async () => {
        const { service, capturedSecrets, restoreEnv } = buildHarness({
            websiteOwner: 'acme',
            userSettings: { kubeconfig: 'apiVersion: v1\n' },
        });
        try {
            await service.deploy('work-1', 'user-1', {});
            const ns = capturedSecrets().find((s: any) => s.key === 'K8S_NAMESPACE');
            expect(ns?.value).toBe('ever-works');
        } finally {
            restoreEnv();
        }
    });

    it('real KubernetesPlugin coerceSettings rejects garbage clusterSource values → back-compat default applies and matrix path matches customer-owned', async () => {
        // Garbage clusterSource: real coerceSettings drops it; settings
        // passed to DeployService still carry `clusterSource: 'nope'`
        // but DeployService.coerceClusterSource also drops it → falls
        // through to 'custom-kubeconfig'.
        const { service, capturedSecrets, restoreEnv } = buildHarness({
            websiteOwner: 'acme',
            userSettings: { clusterSource: 'nope', kubeconfig: 'apiVersion: v1\n' },
        });
        try {
            await service.deploy('work-1', 'user-1', {});
            const cs = capturedSecrets().find((s: any) => s.key === 'K8S_CLUSTER_SOURCE');
            expect(cs?.value).toBe('custom-kubeconfig');
        } finally {
            restoreEnv();
        }
    });
});
