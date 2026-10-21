/**
 * A0.7 (2026-10-17) — the isolated App runtime worker's real port implementations
 * (`app-runtime-worker.adapters.ts`) and the API-side relays they dial, plus the Deployment
 * row store's `update` (the orchestrator's per-phase patch) and decision B1 in
 * `AppDeployPreconditionsService.evaluate`. `ConfigAppsTierPolicy`'s cases moved with the class to
 * `packages/agent/src/apps-tier/__tests__/config-apps-tier-policy.spec.ts` (Resolution R-5).
 *
 * Hand-written fakes only: no database, cluster, network or clock.
 */

import { Logger } from '@nestjs/common';

import { AppDeployDeploymentStoreAdapter } from '../app-deploy-deployment.store';
import { AppDeployPreconditionsService } from '../app-deploy-preconditions.service';
import {
    APP_PULL_OWNER_TOKEN_FALLBACK_ENV,
    APP_PULL_OWNER_TOKEN_NOT_OWNER_SESSION_MESSAGE,
    APP_PULL_OWNER_TOKEN_REFUSED_MESSAGE,
    AppBuildPullCredentialSource,
    AppDeployDispatchRelay,
    AppRuntimeEventRelayService,
    AppRuntimeNotificationProducersAdapter,
    AppRuntimeTargetAdapter,
    PublicGitHubCommitAncestry,
    appDependencyPodLabels,
    appPullOwnerTokenFallbackEnabled,
    workerAppDeployDispatcher,
} from '../app-runtime-worker.adapters';
import { AppPortUnavailableError, AppPullCredentialRefusedError } from '../ports';
import * as workerContext from '../worker-context';

beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('AppBuildPullCredentialSource (APP_IMAGE_PULL_CREDENTIAL_SOURCE)', () => {
    const builds = (imageReference: string | null) => ({
        getBuild: jest.fn(async () => ({
            id: 'b-1',
            commitSha: 'c',
            status: 'succeeded',
            imageReference,
        })),
        listDeployableBuilds: jest.fn(async () => []),
    });
    const works = {
        findById: jest.fn(async () => ({
            id: 'w-1',
            userId: 'u-1',
            gitProvider: 'github',
            owner: 'acme',
        })),
    };

    it('answers null (a public image) when the anonymous pull works, and reads no token', async () => {
        const git = { getAccessToken: jest.fn(async () => 'tok') };
        const fetchImpl = jest.fn(async () => ({
            status: 200,
            ok: true,
            headers: { get: () => null },
        }));
        const source = new AppBuildPullCredentialSource(
            builds('ghcr.io/acme/app/ever-works-app@sha256:' + 'b'.repeat(64)),
            works,
            git,
            fetchImpl,
        );

        await expect(source.resolve('w-1', 'b-1')).resolves.toBeNull();
        expect(git.getAccessToken).not.toHaveBeenCalled();
    });

    it("answers the owner's GitHub token for a private GHCR image on the managed tier", async () => {
        const git = { getAccessToken: jest.fn(async () => 'gh-token') };
        const fetchImpl = jest.fn(async () => ({
            status: 403,
            ok: false,
            headers: { get: () => null },
        }));
        const source = new AppBuildPullCredentialSource(
            builds('ghcr.io/acme/app/ever-works-app:main'),
            works,
            git,
            fetchImpl,
        );

        await expect(source.resolve('w-1', 'b-1', { target: 'ever-works-apps' })).resolves.toEqual({
            server: 'ghcr.io',
            username: 'acme',
            password: 'gh-token',
        });
        expect(git.getAccessToken).toHaveBeenCalledWith({
            userId: 'u-1',
            providerId: 'github',
            workId: 'w-1',
        });
        expect(source.lastSource.get('w-1')).toBe('owner-token');
    });

    it('prefers the stored pull token over the owner token, and records which was used', async () => {
        const git = { getAccessToken: jest.fn(async () => 'gh-token') };
        const fetchImpl = jest.fn(async () => ({
            status: 403,
            ok: false,
            headers: { get: () => null },
        }));
        const stored = {
            read: jest.fn(async () => ({ token: 'ghp_pull_ro', username: 'acme-bot' })),
        };
        const source = new AppBuildPullCredentialSource(
            builds('ghcr.io/acme/app/ever-works-app:main'),
            works,
            git,
            fetchImpl,
            stored,
        );

        await expect(source.resolve('w-1', 'b-1')).resolves.toEqual({
            server: 'ghcr.io',
            username: 'acme-bot',
            password: 'ghp_pull_ro',
        });
        expect(git.getAccessToken).not.toHaveBeenCalled();
        expect(source.lastSource.get('w-1')).toBe('pull-token');

        const fallback = new AppBuildPullCredentialSource(
            builds('ghcr.io/acme/app/ever-works-app:main'),
            works,
            git,
            fetchImpl,
            { read: async () => null },
        );
        await expect(
            fallback.resolve('w-1', 'b-1', { target: 'ever-works-apps' }),
        ).resolves.toMatchObject({
            password: 'gh-token',
        });
        expect(fallback.lastSource.get('w-1')).toBe('owner-token');
    });

    it('refuses with pull_credential_unavailable when nothing can pull it', async () => {
        const fetchImpl = jest.fn(async () => ({
            status: 403,
            ok: false,
            headers: { get: () => null },
        }));
        const noToken = new AppBuildPullCredentialSource(
            builds('ghcr.io/acme/app:main'),
            works,
            { getAccessToken: async () => null },
            fetchImpl,
        );
        await expect(
            noToken.resolve('w-1', 'b-1', { target: 'ever-works-apps' }),
        ).rejects.toMatchObject({
            code: 'pull_credential_unavailable',
        });

        const otherRegistry = new AppBuildPullCredentialSource(
            builds('quay.io/acme/app:1'),
            works,
            undefined,
            fetchImpl,
        );
        await expect(otherRegistry.resolve('w-1', 'b-1')).rejects.toMatchObject({
            code: 'pull_credential_unavailable',
        });

        const noImage = new AppBuildPullCredentialSource(builds(null), works, undefined, fetchImpl);
        await expect(noImage.resolve('w-1', 'b-1')).rejects.toMatchObject({
            code: 'pull_credential_unavailable',
        });
    });
});

/**
 * Security (sec/app-works-gates, 2026-10-18) — the owner's git token is the fallback image-pull
 * credential, rendered as an `imagePullSecret` into the TARGET cluster. On your cluster (any target
 * but `ever-works-apps`, fail-closed) it is refused unless `APP_PULL_OWNER_TOKEN_FALLBACK=true` and
 * the Work owner requested the Deployment from a signed-in session.
 */
describe('AppBuildPullCredentialSource — the owner-token fallback gate (sec/app-works-gates)', () => {
    const PRIVATE = () =>
        jest.fn(async () => ({ status: 403, ok: false, headers: { get: () => null } }));
    const PUBLIC = () =>
        jest.fn(async () => ({ status: 200, ok: true, headers: { get: () => null } }));
    const builds = () => ({
        getBuild: jest.fn(async () => ({
            id: 'b-1',
            commitSha: 'c',
            status: 'succeeded',
            imageReference: 'ghcr.io/acme/app/ever-works-app:main',
        })),
        listDeployableBuilds: jest.fn(async () => []),
    });
    const works = () => ({
        findById: jest.fn(async () => ({
            id: 'w-1',
            userId: 'owner-1',
            gitProvider: 'github',
            owner: 'acme',
        })),
    });
    const gitTokens = (scoped: string | null = null) => ({
        getAccessToken: jest.fn(async () => 'gho_owner_whole_account'),
        getWorkInstallationPackagesReadToken: jest.fn(async () => scoped),
    });
    const OWNER_SESSION = {
        target: 'your-cluster',
        requestedByUserId: 'owner-1',
        requestedByHumanSession: true,
    } as const;

    let saved: string | undefined;
    beforeEach(() => {
        saved = process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV];
        delete process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV];
    });
    afterEach(() => {
        if (saved === undefined) delete process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV];
        else process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV] = saved;
    });

    it('the switch is on only for the exact string "true" (default off)', () => {
        expect(appPullOwnerTokenFallbackEnabled({})).toBe(false);
        expect(appPullOwnerTokenFallbackEnabled({ [APP_PULL_OWNER_TOKEN_FALLBACK_ENV]: '' })).toBe(
            false,
        );
        for (const value of ['TRUE', 'True', ' true', 'true ', '1', 'yes', 'on', 'false']) {
            expect(
                appPullOwnerTokenFallbackEnabled({ [APP_PULL_OWNER_TOKEN_FALLBACK_ENV]: value }),
            ).toBe(false);
        }
        expect(
            appPullOwnerTokenFallbackEnabled({ [APP_PULL_OWNER_TOKEN_FALLBACK_ENV]: 'true' }),
        ).toBe(true);
    });

    it('switch off: your-cluster + private image + no stored token → refused with the clear sentence, no token read', async () => {
        const git = gitTokens('ghs_scoped');
        const source = new AppBuildPullCredentialSource(builds(), works(), git, PRIVATE(), {
            read: async () => null,
        });

        // Even the owner, from a session, does not get it while the switch is off.
        const refusal = await source.resolve('w-1', 'b-1', OWNER_SESSION).catch((error) => error);

        expect(refusal).toBeInstanceOf(AppPullCredentialRefusedError);
        expect(refusal).toBeInstanceOf(AppPortUnavailableError);
        expect(refusal.code).toBe('pull_credential_unavailable');
        expect(refusal.memberFacing).toBe(true);
        expect(refusal.message).toBe(APP_PULL_OWNER_TOKEN_REFUSED_MESSAGE);
        expect(refusal.message).toContain('Store a read-only pull token on the Builds tab');
        expect(refusal.message).not.toContain('gho_');
        expect(git.getAccessToken).not.toHaveBeenCalled();
        expect(git.getWorkInstallationPackagesReadToken).not.toHaveBeenCalled();
        expect(source.lastSource.has('w-1')).toBe(false);
    });

    it('switch off: a missing context, `none` or an unknown target is treated as your cluster (fail closed)', async () => {
        for (const context of [
            undefined,
            {},
            { target: null },
            { target: 'none' },
            { target: 'somewhere-else' },
            { target: 'EVER-WORKS-APPS' },
        ]) {
            const git = gitTokens();
            const source = new AppBuildPullCredentialSource(builds(), works(), git, PRIVATE());

            await expect(source.resolve('w-1', 'b-1', context as never)).rejects.toMatchObject({
                code: 'pull_credential_unavailable',
                message: APP_PULL_OWNER_TOKEN_REFUSED_MESSAGE,
            });
            expect(git.getAccessToken).not.toHaveBeenCalled();
        }
    });

    it('a stored pull token is still used on your cluster, switch off (unchanged)', async () => {
        const git = gitTokens();
        const source = new AppBuildPullCredentialSource(builds(), works(), git, PRIVATE(), {
            read: async () => ({ token: 'ghp_pull_ro', username: 'acme-bot' }),
        });

        await expect(source.resolve('w-1', 'b-1', { target: 'your-cluster' })).resolves.toEqual({
            server: 'ghcr.io',
            username: 'acme-bot',
            password: 'ghp_pull_ro',
        });
        expect(source.lastSource.get('w-1')).toBe('pull-token');
        expect(git.getAccessToken).not.toHaveBeenCalled();
    });

    it('a public image is unchanged on your cluster, switch off: no credential, no token read', async () => {
        const git = gitTokens();
        const stored = { read: jest.fn(async () => ({ token: 'ghp_pull_ro' })) };
        const source = new AppBuildPullCredentialSource(builds(), works(), git, PUBLIC(), stored);

        await expect(source.resolve('w-1', 'b-1', { target: 'your-cluster' })).resolves.toBeNull();
        expect(source.lastSource.get('w-1')).toBe('public');
        expect(stored.read).not.toHaveBeenCalled();
        expect(git.getAccessToken).not.toHaveBeenCalled();
    });

    it('switch on + the owner from a session → the owner token is allowed and recorded', async () => {
        process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV] = 'true';
        const git = gitTokens();
        const source = new AppBuildPullCredentialSource(builds(), works(), git, PRIVATE(), {
            read: async () => null,
        });

        await expect(source.resolve('w-1', 'b-1', OWNER_SESSION)).resolves.toEqual({
            server: 'ghcr.io',
            username: 'acme',
            password: 'gho_owner_whole_account',
        });
        expect(source.lastSource.get('w-1')).toBe('owner-token');
        expect(git.getAccessToken).toHaveBeenCalledWith({
            userId: 'owner-1',
            providerId: 'github',
            workId: 'w-1',
        });
    });

    it('switch on + an editor (not the owner) → refused, no token read', async () => {
        process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV] = 'true';
        const git = gitTokens();
        const source = new AppBuildPullCredentialSource(builds(), works(), git, PRIVATE());

        await expect(
            source.resolve('w-1', 'b-1', { ...OWNER_SESSION, requestedByUserId: 'editor-9' }),
        ).rejects.toMatchObject({
            code: 'pull_credential_unavailable',
            memberFacing: true,
            message: APP_PULL_OWNER_TOKEN_NOT_OWNER_SESSION_MESSAGE,
        });
        expect(git.getAccessToken).not.toHaveBeenCalled();
        expect(git.getWorkInstallationPackagesReadToken).not.toHaveBeenCalled();
    });

    it('switch on + the owner via a non-session (flag false or absent) → refused', async () => {
        process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV] = 'true';
        for (const requestedByHumanSession of [false, undefined, 'true', 1]) {
            const git = gitTokens();
            const source = new AppBuildPullCredentialSource(builds(), works(), git, PRIVATE());

            await expect(
                source.resolve('w-1', 'b-1', {
                    target: 'your-cluster',
                    requestedByUserId: 'owner-1',
                    requestedByHumanSession: requestedByHumanSession as never,
                }),
            ).rejects.toMatchObject({
                code: 'pull_credential_unavailable',
                message: APP_PULL_OWNER_TOKEN_NOT_OWNER_SESSION_MESSAGE,
            });
            expect(git.getAccessToken).not.toHaveBeenCalled();
        }
    });

    it('switch on + a Build-triggered Deployment (no person) → refused', async () => {
        process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV] = 'true';
        for (const context of [
            { target: 'your-cluster', requestedByUserId: null, requestedByHumanSession: false },
            { target: 'your-cluster', requestedByUserId: '', requestedByHumanSession: true },
            { target: 'your-cluster' },
            undefined,
        ]) {
            const git = gitTokens();
            const source = new AppBuildPullCredentialSource(builds(), works(), git, PRIVATE());

            await expect(source.resolve('w-1', 'b-1', context as never)).rejects.toMatchObject({
                code: 'pull_credential_unavailable',
                memberFacing: true,
            });
            expect(git.getAccessToken).not.toHaveBeenCalled();
        }
    });

    it('switch on + a Work whose owner cannot be read → refused (no owner to compare with)', async () => {
        process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV] = 'true';
        const git = gitTokens();
        const source = new AppBuildPullCredentialSource(
            builds(),
            { findById: async () => ({ id: 'w-1', userId: null }) },
            git,
            PRIVATE(),
        );

        await expect(source.resolve('w-1', 'b-1', OWNER_SESSION)).rejects.toMatchObject({
            code: 'pull_credential_unavailable',
            message: APP_PULL_OWNER_TOKEN_NOT_OWNER_SESSION_MESSAGE,
        });
        expect(git.getAccessToken).not.toHaveBeenCalled();
    });

    it('managed tier: unchanged without a person, and prefers the packages:read installation mint', async () => {
        // Switch off, Build-triggered — the managed tier keeps today's fallback.
        const scopedGit = gitTokens('ghs_packages_read_only');
        const scoped = new AppBuildPullCredentialSource(builds(), works(), scopedGit, PRIVATE());

        await expect(
            scoped.resolve('w-1', 'b-1', { target: 'ever-works-apps', requestedByUserId: null }),
        ).resolves.toEqual({
            server: 'ghcr.io',
            username: 'acme',
            password: 'ghs_packages_read_only',
        });
        expect(scopedGit.getWorkInstallationPackagesReadToken).toHaveBeenCalledWith({
            userId: 'owner-1',
            providerId: 'github',
            workId: 'w-1',
        });
        expect(scopedGit.getAccessToken).not.toHaveBeenCalled();
        expect(scoped.lastSource.get('w-1')).toBe('owner-token');

        // No narrowed mint (not App-linked, or the App lacks Packages: read) → today's token.
        const plainGit = gitTokens(null);
        const plain = new AppBuildPullCredentialSource(builds(), works(), plainGit, PRIVATE());
        await expect(
            plain.resolve('w-1', 'b-1', { target: 'ever-works-apps' }),
        ).resolves.toMatchObject({ password: 'gho_owner_whole_account' });
        expect(plainGit.getWorkInstallationPackagesReadToken).toHaveBeenCalledTimes(1);
        expect(plainGit.getAccessToken).toHaveBeenCalledTimes(1);

        // A throwing mint is a null mint, never a failed Deployment.
        const throwingGit = {
            getAccessToken: jest.fn(async () => 'gho_owner_whole_account'),
            getWorkInstallationPackagesReadToken: jest.fn(async () => {
                throw new Error('boom');
            }),
        };
        const throwing = new AppBuildPullCredentialSource(
            builds(),
            works(),
            throwingGit,
            PRIVATE(),
        );
        await expect(
            throwing.resolve('w-1', 'b-1', { target: 'ever-works-apps' }),
        ).resolves.toMatchObject({ password: 'gho_owner_whole_account' });
    });

    it('switch on + the owner from a session on your cluster also prefers the narrowed mint', async () => {
        process.env[APP_PULL_OWNER_TOKEN_FALLBACK_ENV] = 'true';
        const git = gitTokens('ghs_packages_read_only');
        const source = new AppBuildPullCredentialSource(builds(), works(), git, PRIVATE());

        await expect(source.resolve('w-1', 'b-1', OWNER_SESSION)).resolves.toMatchObject({
            password: 'ghs_packages_read_only',
        });
        expect(git.getAccessToken).not.toHaveBeenCalled();
        expect(source.lastSource.get('w-1')).toBe('owner-token');
    });
});

describe('AppRuntimeTargetAdapter (APP_RUNTIME_TARGET)', () => {
    const ref = {
        workId: 'w-1',
        namespace: 'app-w1',
        target: 'your-cluster' as const,
        kubeContext: null,
    };

    it('prepares the namespace through the plugin and answers the ref and the App pod labels', async () => {
        const prepareAppNamespace = jest.fn(async () => ({ warnings: [] }));
        const adapter = new AppRuntimeTargetAdapter(
            {
                resolveClusterAccess: async () => ({
                    outcome: 'access' as const,
                    access: { ref, credential: 'kubeconfig', plugin: { prepareAppNamespace } },
                }),
            },
            { getOrCreate: async () => ({ targetSettings: { networkIsolation: false } }) },
        );

        await expect(adapter.prepareDependencyTarget('w-1')).resolves.toEqual({
            ref,
            podLabels: appDependencyPodLabels('w-1'),
        });
        expect(prepareAppNamespace).toHaveBeenCalledWith(
            ref,
            'kubeconfig',
            expect.objectContaining({ isolation: false }),
        );
    });

    it('maps refusals and failures to the closed unavailable vocabulary, never throwing', async () => {
        const refused = (refusal: string) =>
            new AppRuntimeTargetAdapter({
                resolveClusterAccess: async () => ({ outcome: 'refused' as const, refusal }),
            }).prepareDependencyTarget('w-1');

        await expect(refused('target_none')).resolves.toEqual({ unavailable: 'target_none' });
        await expect(refused('target_not_checked')).resolves.toEqual({
            unavailable: 'target_not_checked',
        });
        await expect(refused('cluster_unreachable')).resolves.toEqual({
            unavailable: 'cluster_unreachable',
        });
        await expect(
            new AppRuntimeTargetAdapter(undefined).prepareDependencyTarget('w-1'),
        ).resolves.toEqual({
            unavailable: 'target_none',
        });

        const foreign = new AppRuntimeTargetAdapter({
            resolveClusterAccess: async () => ({
                outcome: 'access' as const,
                access: {
                    ref,
                    credential: 'k',
                    plugin: {
                        prepareAppNamespace: async () => {
                            throw Object.assign(new Error('owned'), { code: 'namespace_foreign' });
                        },
                    },
                },
            }),
        });
        await expect(foreign.prepareDependencyTarget('w-1')).resolves.toEqual({
            unavailable: 'namespace_owned_elsewhere',
        });
    });
});

describe('AppRuntimeNotificationProducersAdapter (APP_RUNTIME_NOTIFICATIONS)', () => {
    it('writes an urgent, persistent rollback-failed row with the Deploy tab link (ACC-06-24)', async () => {
        const create = jest.fn(async () => ({}));
        const adapter = new AppRuntimeNotificationProducersAdapter({ create });

        await adapter.notifyAppRollbackFailed({
            userId: 'u-1',
            workId: 'w-1',
            deploymentId: 'd-1',
        });
        await adapter.notifyAppDeployFailed({
            userId: 'u-1',
            workId: 'w-1',
            deploymentId: 'd-2',
            code: 'image_pull',
        });

        expect(create).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                isPersistent: true,
                actionUrl: '/works/w-1/deploy',
                deduplicationKey: 'app-deploy:d-1',
                metadata: expect.objectContaining({
                    urgent: true,
                    eventKey: 'app_rollback_failed',
                }),
            }),
        );
        expect(create).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                deduplicationKey: 'app-deploy:d-2',
                message: expect.stringContaining('image_pull'),
            }),
        );
    });
});

describe('PublicGitHubCommitAncestry (APP_COMMIT_ANCESTRY)', () => {
    const answer =
        (status: string, ok = true) =>
        async () => ({ ok, json: async () => ({ status }) });

    it('maps ahead/identical to true, behind/diverged to false, anything else to null', async () => {
        const a = 'a'.repeat(40);
        const b = 'b'.repeat(40);
        await expect(
            new PublicGitHubCommitAncestry(answer('ahead'), undefined).isAncestorCommit(
                'o',
                'r',
                a,
                b,
            ),
        ).resolves.toBe(true);
        await expect(
            new PublicGitHubCommitAncestry(answer('identical'), undefined).isAncestorCommit(
                'o',
                'r',
                a,
                b,
            ),
        ).resolves.toBe(true);
        await expect(
            new PublicGitHubCommitAncestry(answer('diverged'), undefined).isAncestorCommit(
                'o',
                'r',
                a,
                b,
            ),
        ).resolves.toBe(false);
        await expect(
            new PublicGitHubCommitAncestry(answer('x', false), undefined).isAncestorCommit(
                'o',
                'r',
                a,
                b,
            ),
        ).resolves.toBeNull();
        await expect(
            new PublicGitHubCommitAncestry(answer('ahead'), undefined).isAncestorCommit(
                'o/x',
                'r',
                a,
                b,
            ),
        ).resolves.toBeNull();
    });
});

describe('AppRuntimeEventRelayService (the API end of APP_RUNTIME_EVENT_SINK)', () => {
    it('re-emits a catalogued app.* event and refuses an unknown name or a forbidden key', async () => {
        const emit = jest.fn();
        const relay = new AppRuntimeEventRelayService({ emit } as never);

        await relay.emit({
            name: 'app.deploy.succeeded',
            payload: { workId: 'w-1', deploymentId: 'd-1' },
        });
        expect(emit).toHaveBeenCalledWith('app.deploy.succeeded', {
            workId: 'w-1',
            deploymentId: 'd-1',
        });

        await expect(relay.emit({ name: 'work.deleted', payload: {} })).rejects.toThrow(/unknown/);
        await expect(
            relay.emit({ name: 'app.deploy.failed', payload: { nested: { kubeconfig: 'x' } } }),
        ).rejects.toThrow(/forbidden key 'kubeconfig'/);
        expect(emit).toHaveBeenCalledTimes(1);
    });
});

describe('AppDeployDispatchRelay + workerAppDeployDispatcher (the dequeue dispatch)', () => {
    it("dispatches through the API's gate, and answers null when the gate is closed", async () => {
        const dispatchAppDeploy = jest.fn(async (..._args: unknown[]) => 'run-1' as string | null);
        const relay = new AppDeployDispatchRelay({
            isEnabled: () => true,
            resolve: () => ({ dispatchAppDeploy }),
        });
        const payload = {
            workId: 'w',
            deploymentId: 'd',
            trigger: 'build',
            buildId: 'b',
            specCommitSha: null,
        };

        const worker = workerAppDeployDispatcher(relay);
        const resolved = worker.resolve?.() as { dispatchAppDeploy: typeof dispatchAppDeploy };
        await expect(resolved.dispatchAppDeploy(payload)).resolves.toBe('run-1');

        const closed = new AppDeployDispatchRelay({
            isEnabled: () => false,
            resolve: () => ({ dispatchAppDeploy }),
        });
        await expect(closed.dispatchAppDeploy(payload)).resolves.toBeNull();
        await expect(
            new AppDeployDispatchRelay(undefined).dispatchAppDeploy(payload),
        ).resolves.toBeNull();
        expect(dispatchAppDeploy).toHaveBeenCalledTimes(1);
    });
});

describe('AppDeployDeploymentStoreAdapter.update (the orchestrator patch, §5.6 steps 4–7)', () => {
    it('merges appRender, stores ISO timestamps as dates and records the primary URL on READY', async () => {
        const update = jest.fn(async () => undefined);
        const findById = jest.fn(async () => ({
            id: 'd-1',
            workId: 'w-1',
            appRender: { preconditions: [], specCommitSha: 'c' },
        }));
        const store = new AppDeployDeploymentStoreAdapter({ update, findById } as never);

        await store.update('w-1', 'd-1', {
            state: 'READY',
            completedAt: '2026-10-17T10:00:00.000Z',
            lastError: null,
            appRender: { phase: 'done', hosts: { primary: 'demo.apps.example.com', extra: [] } },
        });

        expect(update).toHaveBeenCalledWith('d-1', {
            state: 'READY',
            completedAt: new Date('2026-10-17T10:00:00.000Z'),
            lastError: null,
            appRender: {
                preconditions: [],
                specCommitSha: 'c',
                phase: 'done',
                hosts: { primary: 'demo.apps.example.com', extra: [] },
            },
            website: 'https://demo.apps.example.com',
        });
    });

    it('refuses to patch a Deployment of another Work', async () => {
        const store = new AppDeployDeploymentStoreAdapter({
            update: jest.fn(),
            findById: async () => ({ id: 'd-1', workId: 'other', appRender: {} }),
        } as never);

        await expect(
            store.update('w-1', 'd-1', { appRender: { phase: 'prepare' } }),
        ).rejects.toThrow(/does not belong/);
    });
});

describe('Decision B1 — the dispatcher gate inside the isolated worker', () => {
    afterEach(() => jest.restoreAllMocks());

    const stateWithLock = (lock: string | null) => ({
        getOrCreate: jest.fn(async () => ({ target: 'none', deployLockId: lock })),
    });

    it('in the API (no worker context) an unbound dispatcher still answers worker_not_isolated', async () => {
        jest.spyOn(workerContext, 'isAppClusterWorkerContext').mockReturnValue(false);
        const states = stateWithLock('d-1');
        const service = new AppDeployPreconditionsService(undefined, states as never);

        const result = await service.evaluate({ workId: 'w-1', deploymentId: 'd-1' });

        expect(result.unmet.map((entry) => entry.code)).toEqual(['worker_not_isolated']);
        expect(states.getOrCreate).not.toHaveBeenCalled();
    });

    it('in the worker, the lock-holding Deployment passes step 1 (and meets the next check)', async () => {
        jest.spyOn(workerContext, 'isAppClusterWorkerContext').mockReturnValue(true);
        const states = stateWithLock('d-1');
        const service = new AppDeployPreconditionsService(undefined, states as never);

        const result = await service.evaluate({ workId: 'w-1', deploymentId: 'd-1' });

        expect(result.unmet.map((entry) => entry.code)).toEqual(['target_none']);
        // One read: the early lock check's row is reused for step 2.
        expect(states.getOrCreate).toHaveBeenCalledTimes(1);
    });

    it('in the worker, a Deployment that no longer holds the lock meets the ordinary gate', async () => {
        jest.spyOn(workerContext, 'isAppClusterWorkerContext').mockReturnValue(true);

        for (const lock of [null, 'd-other']) {
            const service = new AppDeployPreconditionsService(
                undefined,
                stateWithLock(lock) as never,
            );
            const result = await service.evaluate({ workId: 'w-1', deploymentId: 'd-1' });

            expect(result.unmet.map((entry) => entry.code)).toEqual(['worker_not_isolated']);
            expect(result.unmet[0].message).toMatch(/deploy lock/);
        }
    });
});
