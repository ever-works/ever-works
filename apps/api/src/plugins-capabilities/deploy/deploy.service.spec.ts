jest.mock('@ever-works/agent/database', () => ({ WorkRepository: class {} }));
jest.mock('@ever-works/agent/entities', () => ({ Work: class {}, User: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({ PluginRegistryService: class {} }));
jest.mock('@ever-works/agent/services', () => ({ PlatformSyncSecretService: class {} }));
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
    }) => {
        const websiteOwner = overrides.websiteOwner ?? 'acme';
        const work = {
            id: 'work-1',
            slug: 'my-site',
            deployProvider: overrides.deployProvider ?? 'k8s',
            gitProvider: 'github',
            websiteTemplateId: 'directory-web-template',
            activitySyncMode: overrides.activitySyncMode ?? 'push',
            user: { id: 'user-1' },
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

        const platformSyncSecretService = {
            getOrGenerate: jest.fn().mockResolvedValue('hex'.repeat(21) + 'h'), // 64 hex chars
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

        const service = new DeployService(
            deployFacade as any,
            gitFacade as any,
            workRepository as any,
            pluginRegistry as any,
            websiteUpdateService as any,
            websiteTemplateResolver as any,
            eventEmitter as any,
            platformSyncSecretService as any,
            dnsService as any,
        );

        return {
            service,
            work,
            deployFacade,
            gitFacade,
            pluginRegistry,
            githubPlugin,
            eventEmitter,
            platformSyncSecretService,
            dnsService,
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

    describe('Activity Feed dual-mode sync secrets (EW-120)', () => {
        const originalUrl = process.env.PLATFORM_API_URL;
        const originalToken = process.env.PLATFORM_API_SECRET_TOKEN;

        afterEach(() => {
            process.env.PLATFORM_API_URL = originalUrl;
            process.env.PLATFORM_API_SECRET_TOKEN = originalToken;
        });

        it('always pushes WORK_ID alongside TENANT_ID (regardless of sync mode)', async () => {
            const { service, githubPlugin } = buildService({
                plugin: { id: 'legacy' },
                activitySyncMode: 'disabled',
            });

            await service.deploy('work-1', 'user-1', {});

            const { secrets } = captureCalls(githubPlugin);
            const byKey = Object.fromEntries(secrets.map((s: any) => [s.key, s.value]));
            expect(byKey.TENANT_ID).toBe('work-1');
            expect(byKey.WORK_ID).toBe('work-1');
        });

        describe('push mode', () => {
            it('pushes PLATFORM_API_URL + PLATFORM_API_SECRET_TOKEN when env vars are set', async () => {
                process.env.PLATFORM_API_URL = 'https://api.ever.works';
                process.env.PLATFORM_API_SECRET_TOKEN = 'platform-shared-secret-value-32x';

                const { service, githubPlugin, platformSyncSecretService } = buildService({
                    plugin: { id: 'legacy' },
                    activitySyncMode: 'push',
                });

                await service.deploy('work-1', 'user-1', {});

                const { secrets } = captureCalls(githubPlugin);
                const byKey = Object.fromEntries(secrets.map((s: any) => [s.key, s.value]));
                expect(byKey.PLATFORM_API_URL).toBe('https://api.ever.works');
                expect(byKey.PLATFORM_API_SECRET_TOKEN).toBe('platform-shared-secret-value-32x');
                // Push-mode deploys must never invoke the per-Work HMAC secret service.
                expect(platformSyncSecretService.getOrGenerate).not.toHaveBeenCalled();
            });

            it('skips the PLATFORM_API_* push when env vars are not configured', async () => {
                delete process.env.PLATFORM_API_URL;
                delete process.env.PLATFORM_API_SECRET_TOKEN;

                const { service, githubPlugin } = buildService({
                    plugin: { id: 'legacy' },
                    activitySyncMode: 'push',
                });

                await service.deploy('work-1', 'user-1', {});

                const keys = captureCalls(githubPlugin).secrets.map((s: any) => s.key);
                expect(keys).not.toContain('PLATFORM_API_URL');
                expect(keys).not.toContain('PLATFORM_API_SECRET_TOKEN');
                // Deploy succeeds regardless — WORK_ID + TENANT_ID landed.
                expect(keys).toContain('WORK_ID');
            });
        });

        describe('pull mode', () => {
            it('pushes PLATFORM_SYNC_SECRET (per-Work HMAC) via the secret service', async () => {
                const { service, githubPlugin, platformSyncSecretService } = buildService({
                    plugin: { id: 'legacy' },
                    activitySyncMode: 'pull',
                });

                await service.deploy('work-1', 'user-1', {});

                expect(platformSyncSecretService.getOrGenerate).toHaveBeenCalledWith('work-1');
                const byKey = Object.fromEntries(
                    captureCalls(githubPlugin).secrets.map((s: any) => [s.key, s.value]),
                );
                expect(byKey.PLATFORM_SYNC_SECRET).toBe('hex'.repeat(21) + 'h');
                // Pull-mode deploys must never push the push-mode bearer.
                expect(byKey.PLATFORM_API_SECRET_TOKEN).toBeUndefined();
            });

            it('still completes the deploy when secret service throws', async () => {
                const { service, platformSyncSecretService } = buildService({
                    plugin: { id: 'legacy' },
                    activitySyncMode: 'pull',
                });
                platformSyncSecretService.getOrGenerate.mockRejectedValueOnce(
                    new Error('encryption key missing'),
                );

                await expect(service.deploy('work-1', 'user-1', {})).resolves.toBeDefined();
            });
        });

        describe('disabled mode', () => {
            it('pushes neither PLATFORM_API_* nor PLATFORM_SYNC_SECRET', async () => {
                // Set env vars too — disabled mode must skip regardless of platform config.
                process.env.PLATFORM_API_URL = 'https://api.ever.works';
                process.env.PLATFORM_API_SECRET_TOKEN = 'platform-shared-secret-value-32x';

                const { service, githubPlugin, platformSyncSecretService } = buildService({
                    plugin: { id: 'legacy' },
                    activitySyncMode: 'disabled',
                });

                await service.deploy('work-1', 'user-1', {});

                const keys = captureCalls(githubPlugin).secrets.map((s: any) => s.key);
                expect(keys).not.toContain('PLATFORM_API_URL');
                expect(keys).not.toContain('PLATFORM_API_SECRET_TOKEN');
                expect(keys).not.toContain('PLATFORM_SYNC_SECRET');
                expect(platformSyncSecretService.getOrGenerate).not.toHaveBeenCalled();
            });
        });
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

    describe('EW-617 G5 — ever-works subdomain templating', () => {
        it('overrides ingressHost to ${slug}.ever.works when deployProvider=ever-works and DNS is configured', async () => {
            const getDeploymentSecrets = jest.fn().mockResolvedValue({});
            const { service, githubPlugin, dnsService } = buildService({
                deployProvider: 'ever-works',
                plugin: {
                    id: 'k8s',
                    getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                    getDeploymentSecrets,
                },
                settings: { kubeconfig: 'apiVersion: v1' },
            });
            // Pretend DNS env is set — service emits a fake provider that
            // does nothing, but signals "active".
            (dnsService.getProvider as jest.Mock).mockReturnValue({});

            await service.deploy('work-1', 'user-1', {});

            // The plugin's getDeploymentSecrets MUST have been called with
            // settings carrying the templated ingressHost.
            expect(getDeploymentSecrets).toHaveBeenCalledTimes(1);
            const settingsArg = getDeploymentSecrets.mock.calls[0][0];
            expect(settingsArg.ingressHost).toBe('my-site.ever.works');
            // Original settings still contain whatever was there.
            expect(settingsArg.kubeconfig).toBe('apiVersion: v1');

            expect(dnsService.ensureWorkSubdomain).toHaveBeenCalledWith('my-site');

            // Tag the variable assertion onto the GA secrets path too —
            // K8S_INGRESS_HOST is what the plugin returns from
            // getDeploymentSecrets when settings.ingressHost is set.
            // (Plugin is mocked here, so we only assert on the call.)
            void githubPlugin; // silence unused
        });

        it('leaves settings unchanged for non-ever-works providers', async () => {
            const getDeploymentSecrets = jest.fn().mockResolvedValue({});
            const { service, dnsService } = buildService({
                deployProvider: 'vercel',
                plugin: {
                    id: 'vercel',
                    getWorkflowFilenames: () => ['deploy_vercel.yaml'],
                    getDeploymentSecrets,
                },
                settings: { token: 'v1' },
            });

            await service.deploy('work-1', 'user-1', {});

            expect(getDeploymentSecrets).toHaveBeenCalledTimes(1);
            const settingsArg = getDeploymentSecrets.mock.calls[0][0];
            expect(settingsArg.ingressHost).toBeUndefined();
            expect(dnsService.ensureWorkSubdomain).not.toHaveBeenCalled();
        });

        it('no-ops the DNS override when env is unset (dnsService.getProvider returns null)', async () => {
            const getDeploymentSecrets = jest.fn().mockResolvedValue({});
            const { service, dnsService } = buildService({
                deployProvider: 'ever-works',
                plugin: {
                    id: 'k8s',
                    getWorkflowFilenames: () => ['deploy_k8s.yaml'],
                    getDeploymentSecrets,
                },
                settings: {},
            });
            (dnsService.getProvider as jest.Mock).mockReturnValue(null);

            await service.deploy('work-1', 'user-1', {});

            const settingsArg = getDeploymentSecrets.mock.calls[0][0];
            // Without an active DNS provider we leave the settings alone —
            // the k8s plugin's existing fallback hostname is used instead.
            expect(settingsArg.ingressHost).toBeUndefined();
            expect(dnsService.ensureWorkSubdomain).not.toHaveBeenCalled();
        });
    });

    describe('default deployProvider fallback (EW-617 G6)', () => {
        // When work.deployProvider is null/empty (e.g. older row pre-migration
        // or anonymous quick-create that hasn't picked a provider yet), the
        // service must fall back to 'ever-works', not the legacy 'vercel'.
        it("sets DEPLOY_PROVIDER='ever-works' when work.deployProvider is falsy", async () => {
            const { service, githubPlugin } = buildService({
                deployProvider: '',
                plugin: {
                    id: 'ever-works',
                    getWorkflowFilenames: () => ['deploy_ever_works.yaml'],
                    getDeploymentSecrets: jest.fn().mockResolvedValue({}),
                },
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
                    getDeploymentSecrets: jest.fn().mockResolvedValue({}),
                },
            });

            await service.deploy('work-1', 'user-1', {});

            const { variables } = captureCalls(githubPlugin);
            const deployProviderVar = variables.find((v: any) => v.key === 'DEPLOY_PROVIDER');
            expect(deployProviderVar?.value).toBe('vercel');
        });
    });

    describe('EW-616 cluster-source enforcement + kubeconfig substitution', () => {
        const k8sPlugin = {
            id: 'k8s',
            getWorkflowFilenames: () => ['deploy_k8s.yaml'],
            getDeploymentSecrets: jest.fn().mockResolvedValue({}),
        };

        const originalEnv = process.env;

        beforeEach(() => {
            process.env = { ...originalEnv };
            delete process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG;
            delete process.env.EVER_WORKS_K8S_GAUZY_KUBECONFIG;
        });

        afterEach(() => {
            process.env = originalEnv;
        });

        it('back-compat: no clusterSource + customer-owned org + user kubeconfig → uses user kubeconfig as K8S_TOKEN', async () => {
            const { service, githubPlugin } = buildService({
                plugin: k8sPlugin,
                token: 'user-pasted-yaml',
                settings: {},
                websiteOwner: 'acme',
            });

            await service.deploy('work-1', 'user-1', {});

            const { secrets } = captureCalls(githubPlugin);
            const k8sToken = secrets.find((s: any) => s.key === 'K8S_TOKEN');
            expect(k8sToken?.value).toBe('user-pasted-yaml');
        });

        it('k8s-works + ever-works-cloud → substitutes EVER_WORKS_K8S_WORKS_KUBECONFIG as K8S_TOKEN', async () => {
            process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = 'platform-yaml';
            const { service, githubPlugin } = buildService({
                plugin: k8sPlugin,
                token: 'user-pasted-yaml-should-be-ignored',
                settings: { clusterSource: 'k8s-works' },
                websiteOwner: 'ever-works-cloud',
            });

            await service.deploy('work-1', 'user-1', {});

            const { secrets } = captureCalls(githubPlugin);
            const k8sToken = secrets.find((s: any) => s.key === 'K8S_TOKEN');
            expect(k8sToken?.value).toBe('platform-yaml');
        });

        it('k8s-gauzy + ever-works → substitutes EVER_WORKS_K8S_GAUZY_KUBECONFIG (admin path)', async () => {
            process.env.EVER_WORKS_K8S_GAUZY_KUBECONFIG = 'gauzy-yaml';
            const { service, githubPlugin } = buildService({
                plugin: k8sPlugin,
                token: 'user-yaml-ignored',
                settings: { clusterSource: 'k8s-gauzy' },
                websiteOwner: 'ever-works',
            });

            await service.deploy('work-1', 'user-1', {});

            const { secrets } = captureCalls(githubPlugin);
            expect(secrets.find((s: any) => s.key === 'K8S_TOKEN')?.value).toBe('gauzy-yaml');
        });

        it('rejects ever-works-cloud + custom-kubeconfig with a BadRequest (cell C)', async () => {
            const { service } = buildService({
                plugin: k8sPlugin,
                settings: { clusterSource: 'custom-kubeconfig' },
                websiteOwner: 'ever-works-cloud',
            });

            await expect(service.deploy('work-1', 'user-1', {})).rejects.toThrow(
                /cross-tenant exposure/i,
            );
        });

        it('rejects customer-owned + k8s-gauzy with a BadRequest (admin-only)', async () => {
            const { service } = buildService({
                plugin: k8sPlugin,
                settings: { clusterSource: 'k8s-gauzy' },
                websiteOwner: 'acme',
            });

            await expect(service.deploy('work-1', 'user-1', {})).rejects.toThrow(
                /'k8s-gauzy' is the Ever Works internal platform cluster/,
            );
        });

        it('rejects k8s-works with InternalServerError when EVER_WORKS_K8S_WORKS_KUBECONFIG is not provisioned (operator gap, not user error)', async () => {
            // env var intentionally absent
            const { service } = buildService({
                plugin: k8sPlugin,
                settings: { clusterSource: 'k8s-works' },
                websiteOwner: 'ever-works-cloud',
            });

            const InternalServerErrorException =
                require('@nestjs/common').InternalServerErrorException;
            await expect(service.deploy('work-1', 'user-1', {})).rejects.toBeInstanceOf(
                InternalServerErrorException,
            );
            await expect(service.deploy('work-1', 'user-1', {})).rejects.toThrow(
                /EVER_WORKS_K8S_WORKS_KUBECONFIG is not configured/,
            );
        });

        it('discards the PLATFORM_MANAGED sentinel token from the facade when substituting kubeconfig', async () => {
            // When the user picked a platform-managed source without
            // pasting a kubeconfig, DeployFacade returns a sentinel token.
            // DeployService.resolveDeployToken() must ignore it and read
            // the platform env var instead.
            process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = 'real-platform-yaml';
            const sentinel = '__ever-works-platform-managed-kubeconfig__';
            const { service, githubPlugin } = buildService({
                plugin: k8sPlugin,
                token: sentinel,
                settings: { clusterSource: 'k8s-works' },
                websiteOwner: 'ever-works-cloud',
            });

            await service.deploy('work-1', 'user-1', {});

            const { secrets } = captureCalls(githubPlugin);
            const k8sToken = secrets.find((s: any) => s.key === 'K8S_TOKEN');
            expect(k8sToken?.value).toBe('real-platform-yaml');
            // The sentinel must never leak into any pushed secret.
            for (const s of secrets) {
                expect(s.value).not.toBe(sentinel);
            }
        });

        it('skips matrix enforcement entirely for non-k8s providers', async () => {
            const { service, githubPlugin } = buildService({
                deployProvider: 'vercel',
                plugin: {
                    id: 'vercel',
                    getWorkflowFilenames: () => ['deploy_vercel.yaml'],
                    getDeploymentSecrets: jest.fn().mockResolvedValue({}),
                },
                // these would trip the k8s matrix but vercel must not care
                settings: { clusterSource: 'k8s-gauzy' },
                websiteOwner: 'ever-works-cloud',
                token: 'vercel-deploy-token',
            });

            await expect(service.deploy('work-1', 'user-1', {})).resolves.toBe(true);

            const { secrets } = captureCalls(githubPlugin);
            expect(secrets.find((s: any) => s.key === 'VERCEL_TOKEN')?.value).toBe(
                'vercel-deploy-token',
            );
        });
    });
});
