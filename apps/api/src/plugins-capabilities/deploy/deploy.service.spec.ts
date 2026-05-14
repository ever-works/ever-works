jest.mock('@ever-works/agent/database', () => ({ WorkRepository: class {} }));
jest.mock('@ever-works/agent/entities', () => ({ Work: class {}, User: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({ PluginRegistryService: class {} }));
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
describe('DeployService — plugin-driven dispatch + secrets', () => {
    const buildService = (overrides: {
        plugin: Record<string, unknown>;
        token?: string;
        settings?: Record<string, unknown>;
        deployProvider?: string;
        /** Settings returned by deployFacade.getOtherPluginSettings('github', ...).
         *  Defaults to an empty object (no PAT saved). Tests for the GHCR PAT
         *  flow override this with `{ readPackagesPat: '...' }`. */
        githubPluginSettings?: Record<string, unknown>;
    }) => {
        const work = {
            id: 'work-1',
            slug: 'my-site',
            deployProvider: overrides.deployProvider ?? 'k8s',
            gitProvider: 'github',
            websiteTemplateId: 'directory-web-template',
            user: { id: 'user-1' },
            getRepoOwner: () => 'acme',
            getDataRepo: () => 'acme/data',
            getWebsiteRepo: () => 'acme-site',
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

        const workRepository = { findById: jest.fn().mockResolvedValue(work) };

        // Single shared GitHub plugin stub returned by every
        // pluginRegistry.get('github') call. Capturing its call history is
        // what tests assert against.
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

        const websiteUpdateService = {
            updateRepository: jest.fn().mockResolvedValue(undefined),
        };

        const websiteTemplateResolver = {
            resolveForWork: jest.fn().mockResolvedValue({ branch: 'main' }),
        };

        const eventEmitter = {
            emit: jest.fn(),
        };

        const service = new DeployService(
            deployFacade as any,
            gitFacade as any,
            workRepository as any,
            pluginRegistry as any,
            websiteUpdateService as any,
            websiteTemplateResolver as any,
            eventEmitter as any,
        );

        return {
            service,
            work,
            deployFacade,
            gitFacade,
            pluginRegistry,
            githubPlugin,
            eventEmitter,
        };
    };

    const captureCalls = (gh: ReturnType<typeof buildService>['githubPlugin']) => ({
        secrets: gh.setActionSecret.mock.calls.map((c: any[]) => c[0]),
        variables: gh.setActionVariable.mock.calls.map((c: any[]) => c[0]),
        dispatches: gh.dispatchWorkflow.mock.calls.map((c: any[]) => c[0]),
    });

    it('uses plugin.getWorkflowFilenames() for the dispatch list', async () => {
        const { service, githubPlugin } = buildService({
            plugin: {
                id: 'k8s',
                getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                getDeploymentSecrets: jest.fn().mockResolvedValue({}),
            },
        });

        const result = await service.deploy('work-1', 'user-1', {});

        const { dispatches } = captureCalls(githubPlugin);
        const workflows = dispatches.map((d: any) => d.workflow);
        expect(workflows).toEqual(['deploy_k8s.yaml']);
    });

    it('falls back to deploy_prod.yaml for plugins without getWorkflowFilenames', async () => {
        const { service, githubPlugin } = buildService({
            plugin: { id: 'legacy' },
        });

        const result = await service.deploy('work-1', 'user-1', {});

        const { dispatches } = captureCalls(githubPlugin);
        expect(dispatches.map((d: any) => d.workflow)).toEqual(['deploy_prod.yaml']);
    });

    it('honours the Vercel plugin override (deploy_vercel.yaml then deploy_prod.yaml)', async () => {
        const { service, githubPlugin } = buildService({
            deployProvider: 'vercel',
            plugin: {
                id: 'vercel',
                getWorkflowFilenames: () => ['deploy_vercel.yaml', 'deploy_prod.yaml'],
                getDeploymentSecrets: jest.fn().mockResolvedValue({}),
            },
        });

        await service.deploy('work-1', 'user-1', {});

        const { dispatches } = captureCalls(githubPlugin);
        const workflows = dispatches.map((d: any) => d.workflow);
        expect(workflows[0]).toBe('deploy_vercel.yaml');
    });

    it('pushes plugin.getDeploymentSecrets() entries as GitHub Actions secrets', async () => {
        const { service, githubPlugin } = buildService({
            plugin: {
                id: 'k8s',
                getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                getDeploymentSecrets: jest.fn().mockResolvedValue({
                    K8S_NAMESPACE: 'apps',
                    K8S_REGISTRY_KIND: 'github',
                    K8S_INGRESS_HOST: 'tools.example.com',
                }),
            },
            settings: { kubeconfig: 'apiVersion: v1\nkind: Config\n' },
        });

        await service.deploy('work-1', 'user-1', {});

        const { secrets } = captureCalls(githubPlugin);
        const byKey = Object.fromEntries(secrets.map((s: any) => [s.key, s.value]));
        expect(byKey.K8S_NAMESPACE).toBe('apps');
        expect(byKey.K8S_REGISTRY_KIND).toBe('github');
        expect(byKey.K8S_INGRESS_HOST).toBe('tools.example.com');
        // Existing standard secrets are still pushed.
        expect(byKey.TENANT_ID).toBe('work-1');
        expect(byKey.K8S_TOKEN).toBe('kubeconfig:::yaml');
        expect(byKey.DEPLOY_TOKEN).toBe('kubeconfig:::yaml');
    });

    it('pushes nothing extra for plugins without getDeploymentSecrets', async () => {
        const { service, githubPlugin } = buildService({
            plugin: { id: 'legacy' },
        });

        await service.deploy('work-1', 'user-1', {});

        const { secrets } = captureCalls(githubPlugin);
        const keys = secrets.map((s: any) => s.key).sort();
        // Only the 4 standard secrets + CRON_SECRET.
        expect(keys).toEqual(
            expect.arrayContaining([
                'CRON_SECRET',
                'DATA_REPOSITORY',
                'DEPLOY_TOKEN',
                'K8S_TOKEN',
                'TENANT_ID',
            ]),
        );
        // No K8S_-prefixed extras (they only come from getDeploymentSecrets).
        expect(keys.filter((k: string) => k.startsWith('K8S_INGRESS'))).toEqual([]);
    });

    it('does not leak the plugin token (kubeconfig) into pushed secret values from getDeploymentSecrets', async () => {
        const kubeconfigYaml = 'apiVersion: v1\nkind: Config\nusers:\n  - token: leaked-12345';
        const { service, githubPlugin } = buildService({
            plugin: {
                id: 'k8s',
                getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                // Hostile plugin returns the token by mistake — the deploy
                // service still pushes it (this is on the plugin, not us)
                // but our standard secrets path should never include it
                // anywhere unexpected. This test pins the boundary.
                getDeploymentSecrets: jest.fn().mockResolvedValue({ K8S_NAMESPACE: 'apps' }),
            },
            settings: { kubeconfig: kubeconfigYaml },
            token: kubeconfigYaml,
        });

        await service.deploy('work-1', 'user-1', {});

        const { secrets, variables } = captureCalls(githubPlugin);
        const namespaceSecret = secrets.find((s: any) => s.key === 'K8S_NAMESPACE');
        expect(namespaceSecret?.value).toBe('apps');
        // Vars never carry the kubeconfig.
        const allVarValues = variables.map((v: any) => v.value).join('\n');
        expect(allVarValues).not.toContain('leaked-12345');
    });

    describe('Kubernetes GHCR pull token (bug D)', () => {
        it('pushes GITHUB_READ_PACKAGES_TOKEN when deployProvider=k8s and the user has saved a PAT', async () => {
            const { service, githubPlugin, deployFacade } = buildService({
                plugin: {
                    id: 'k8s',
                    getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                    getDeploymentSecrets: jest.fn().mockResolvedValue({}),
                },
                githubPluginSettings: { readPackagesPat: 'ghp_fine_grained_pat_value' },
            });

            await service.deploy('work-1', 'user-1', {});

            // The facade was asked for the GitHub plugin's settings, not just
            // the deploy plugin's — that's the cross-plugin read this flow
            // requires.
            expect(deployFacade.getOtherPluginSettings).toHaveBeenCalledWith('github', {
                userId: 'user-1',
                workId: 'work-1',
            });

            const { secrets } = captureCalls(githubPlugin);
            const pat = secrets.find((s: any) => s.key === 'GITHUB_READ_PACKAGES_TOKEN');
            expect(pat?.value).toBe('ghp_fine_grained_pat_value');
        });

        it('does NOT push GITHUB_READ_PACKAGES_TOKEN when no PAT is saved', async () => {
            const { service, githubPlugin, deployFacade } = buildService({
                plugin: {
                    id: 'k8s',
                    getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                    getDeploymentSecrets: jest.fn().mockResolvedValue({}),
                },
                githubPluginSettings: {},
            });

            await service.deploy('work-1', 'user-1', {});

            expect(deployFacade.getOtherPluginSettings).toHaveBeenCalledTimes(1);
            const { secrets } = captureCalls(githubPlugin);
            expect(
                secrets.find((s: any) => s.key === 'GITHUB_READ_PACKAGES_TOKEN'),
            ).toBeUndefined();
        });

        it('skips the cross-plugin read entirely for non-k8s providers', async () => {
            const { service, githubPlugin, deployFacade } = buildService({
                deployProvider: 'vercel',
                plugin: {
                    id: 'vercel',
                    getWorkflowFilenames: () => ['deploy_vercel.yaml'],
                    getDeploymentSecrets: jest.fn().mockResolvedValue({}),
                },
                githubPluginSettings: { readPackagesPat: 'should-not-be-pushed' },
            });

            await service.deploy('work-1', 'user-1', {});

            // Vercel doesn't need a packages PAT — the cross-plugin read is
            // a no-op for non-k8s flows so we don't even ask.
            expect(deployFacade.getOtherPluginSettings).not.toHaveBeenCalled();
            const { secrets } = captureCalls(githubPlugin);
            expect(
                secrets.find((s: any) => s.key === 'GITHUB_READ_PACKAGES_TOKEN'),
            ).toBeUndefined();
        });

        it('does not block the deploy when the GitHub plugin settings lookup throws', async () => {
            const { service, githubPlugin, deployFacade } = buildService({
                plugin: {
                    id: 'k8s',
                    getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                    getDeploymentSecrets: jest.fn().mockResolvedValue({}),
                },
            });
            deployFacade.getOtherPluginSettings.mockRejectedValueOnce(new Error('boom'));

            await expect(service.deploy('work-1', 'user-1', {})).resolves.toBe(true);

            // Deploy still ran — the standard k8s secrets were pushed.
            const { secrets } = captureCalls(githubPlugin);
            expect(secrets.find((s: any) => s.key === 'K8S_TOKEN')).toBeDefined();
        });

        it('trims whitespace and treats blank/whitespace-only PATs as missing', async () => {
            const { service, githubPlugin } = buildService({
                plugin: {
                    id: 'k8s',
                    getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                    getDeploymentSecrets: jest.fn().mockResolvedValue({}),
                },
                githubPluginSettings: { readPackagesPat: '   \n\t ' },
            });

            await service.deploy('work-1', 'user-1', {});

            const { secrets } = captureCalls(githubPlugin);
            expect(
                secrets.find((s: any) => s.key === 'GITHUB_READ_PACKAGES_TOKEN'),
            ).toBeUndefined();
        });
    });

    it('emits DeploymentDispatchedEvent after a successful dispatch', async () => {
        const { service, eventEmitter } = buildService({
            plugin: {
                id: 'k8s',
                providerName: 'kubernetes',
                getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                getDeploymentSecrets: jest.fn().mockResolvedValue({}),
            },
        });

        await service.deploy('work-1', 'user-1', {});

        const emitCall = eventEmitter.emit.mock.calls.find(
            (c: any[]) => c[0] === 'deployment.dispatched',
        );
        expect(emitCall).toBeDefined();
        const event = emitCall![1];
        expect(event.payload.userId).toBe('user-1');
        expect(event.payload.providerId).toBe('k8s');
        expect(event.payload.providerName).toBe('kubernetes');
    });

    it('does not emit DeploymentDispatchedEvent when dispatch fails entirely', async () => {
        const { service, githubPlugin, eventEmitter } = buildService({
            plugin: {
                id: 'k8s',
                getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                getDeploymentSecrets: jest.fn().mockResolvedValue({}),
            },
        });
        // Make every dispatch attempt throw — neither initial try nor the
        // post-trigger-commit retry succeeds. (websiteUpdateService still
        // resolves so the service's catch path runs cleanly.)
        githubPlugin.dispatchWorkflow.mockRejectedValue(new Error('dispatch failed'));

        const result = await service.deploy('work-1', 'user-1', {});

        const emitted = eventEmitter.emit.mock.calls.find(
            (c: any[]) => c[0] === 'deployment.dispatched',
        );
        expect(result).toBe(false);
        expect(emitted).toBeUndefined();
    });

    it('logs but does not fail the deploy if getDeploymentSecrets throws', async () => {
        const errorSpy = jest
            .spyOn(require('@nestjs/common').Logger.prototype, 'error')
            .mockImplementation(() => {});

        const { service, githubPlugin } = buildService({
            plugin: {
                id: 'k8s',
                getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                getDeploymentSecrets: jest.fn().mockRejectedValue(new Error('boom')),
            },
        });

        const result = await service.deploy('work-1', 'user-1', {});

        // Deploy still went through (workflow dispatched).
        const { dispatches } = captureCalls(githubPlugin);
        expect(dispatches.length).toBeGreaterThan(0);
        expect(result).toBe(true);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to push plugin-specific secrets for k8s'),
        );

        errorSpy.mockRestore();
    });

    describe('default deployProvider fallback (EW-617 G6)', () => {
        // When work.deployProvider is null/empty (e.g. older row pre-migration
        // or anonymous quick-create that hasn't picked a provider yet), the
        // service must fall back to 'ever-works', not the legacy 'vercel'.
        it("sets DEPLOY_PROVIDER='ever-works' when work.deployProvider is falsy", async () => {
            const { service, githubPlugin } = buildService({
                deployProvider: '',
                plugin: { id: 'ever-works' },
            });

            await service.deploy('work-1', 'user-1', {});

            const { variables } = captureCalls(githubPlugin);
            const deployProviderVar = variables.find((v: any) => v.key === 'DEPLOY_PROVIDER');
            expect(deployProviderVar?.value).toBe('ever-works');
        });

        it('uses work.deployProvider when explicitly set (no override)', async () => {
            const { service, githubPlugin } = buildService({
                deployProvider: 'vercel',
                plugin: {
                    id: 'vercel',
                    getWorkflowFilenames: () => ['deploy_vercel.yaml', 'deploy_prod.yaml'],
                },
            });

            await service.deploy('work-1', 'user-1', {});

            const { variables } = captureCalls(githubPlugin);
            const deployProviderVar = variables.find((v: any) => v.key === 'DEPLOY_PROVIDER');
            expect(deployProviderVar?.value).toBe('vercel');
        });
    });
});
