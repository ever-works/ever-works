import type { IBuildPlugin } from '@ever-works/plugin';

import {
    BuildFacadeService,
    type BuildRepositoryFactsSource,
    type BuildTokenSource,
} from '../build-facade.service';

/**
 * APW-05 T16 — `BuildFacadeService`, the binding behind `APP_BUILD_PLUGIN_RESOLVER`.
 *
 * Four services in this epic inject that token and nothing provided it, so every
 * one of them took its `pluginUnavailable` branch. What these cases pin is the
 * shape of the refusals — because a resolver that answers a *plausible* binding
 * when it should refuse is worse than one that is unbound: an unbound token is
 * at least visible in the dormancy register.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function work(overrides: Record<string, unknown> = {}) {
    return {
        id: WORK_ID,
        getWebsiteRepo: () => 'Their-App',
        getRepoOwner: () => 'Acme-Org',
        ...overrides,
    };
}

function registryOf(plugins: Array<Partial<IBuildPlugin> & { id: string }>) {
    return {
        getAll: () =>
            plugins.map((plugin) => ({
                state: 'loaded',
                manifest: { capabilities: ['build'] },
                plugin,
            })),
    } as never;
}

function buildPlugin(overrides: Partial<IBuildPlugin> = {}) {
    return {
        id: 'github-actions-build',
        buildKind: 'github-actions',
        startBuild: async () => ({
            providerRunId: '9001',
            dispatchedAt: '2026-09-21T10:00:00.000Z',
        }),
        cancelBuild: async () => undefined,
        ...overrides,
    } as Partial<IBuildPlugin> & { id: string };
}

const tokens: BuildTokenSource = { getBuildToken: async () => 'ghs-not-a-real-token' };

function facade(options: {
    plugins?: Array<Partial<IBuildPlugin> & { id: string }>;
    found?: unknown;
    tokens?: BuildTokenSource;
    facts?: BuildRepositoryFactsSource;
}) {
    // `'found' in options` and not `?? work()`: a case that passes `found: null`
    // means "the Work does not exist", and `null ?? work()` would quietly hand
    // it one anyway — which is how that case passed while asserting nothing.
    const found = 'found' in options ? options.found : work();
    const repository = { findById: async () => found } as never;
    return new BuildFacadeService(
        registryOf(options.plugins ?? [buildPlugin()]),
        repository,
        options.tokens,
        options.facts,
    );
}

describe('BuildFacadeService (APW-05 T16)', () => {
    it('resolves the one loaded plugin that declares the `build` capability', async () => {
        const binding = await facade({ tokens }).resolve(WORK_ID, USER_ID);

        expect(binding?.pluginId).toBe('github-actions-build');
        expect(binding?.buildKind).toBe('github-actions');
    });

    it('derives the image repository, lower-cased, because GHCR rejects anything else', async () => {
        const binding = await facade({ tokens }).resolve(WORK_ID, USER_ID);

        // `Acme-Org/Their-App` on GitHub; `ghcr.io/acme-org/their-app` as an image.
        expect(binding?.imageRepository).toBe('ghcr.io/acme-org/their-app');
    });

    it('reads the WORK Repository (`website` role), not the `data` role', async () => {
        // The owner's repository-role note: `website` holds the app code and is
        // what a Build builds. `data` is where DATA lives, and building it would
        // be building the wrong repository.
        const getWebsiteRepo = jest.fn(() => 'the-app-code');
        const binding = await facade({
            tokens,
            found: work({ getWebsiteRepo, getRepoOwner: () => 'acme' }),
        }).resolve(WORK_ID, USER_ID);

        expect(getWebsiteRepo).toHaveBeenCalled();
        expect(binding?.imageRepository).toBe('ghcr.io/acme/the-app-code');
    });

    describe('the refusals — every one answers null, none throws', () => {
        it('refuses when the Work does not exist', async () => {
            expect(await facade({ tokens, found: null }).resolve(WORK_ID, USER_ID)).toBeNull();
        });

        it('refuses when no loaded plugin declares the capability', async () => {
            expect(await facade({ tokens, plugins: [] }).resolve(WORK_ID, USER_ID)).toBeNull();
        });

        it('refuses when TWO plugins declare it, rather than picking one', async () => {
            // Picking silently would mean the platform deciding where a member's
            // code is built. When a second build plugin lands, this case is the
            // one that has to change, and it should change deliberately.
            const binding = await facade({
                tokens,
                plugins: [buildPlugin(), buildPlugin({ id: 'some-other-builder' })],
            }).resolve(WORK_ID, USER_ID);

            expect(binding).toBeNull();
        });

        it('refuses when no credential source is bound at all', async () => {
            expect(await facade({}).resolve(WORK_ID, USER_ID)).toBeNull();
        });

        it('refuses when the credential source answers empty, and does not throw', async () => {
            const empty: BuildTokenSource = { getBuildToken: async () => '   ' };
            expect(await facade({ tokens: empty }).resolve(WORK_ID, USER_ID)).toBeNull();
        });

        it('treats a throwing credential lookup as "no credential", not as a crash', async () => {
            const angry: BuildTokenSource = {
                getBuildToken: async () => {
                    throw new Error('the credential store is down');
                },
            };
            await expect(facade({ tokens: angry }).resolve(WORK_ID, USER_ID)).resolves.toBeNull();
        });
    });

    describe('repository facts default to the SAFE answer, not the convenient one', () => {
        it('private and not-ours when no facts source is bound', async () => {
            const startBuild = jest.fn(async (..._args: unknown[]) => ({
                providerRunId: '1',
                dispatchedAt: '2026-09-21T10:00:00.000Z',
            }));
            const binding = await facade({
                tokens,
                plugins: [buildPlugin({ startBuild })],
            }).resolve(WORK_ID, USER_ID);

            await binding?.startBuild?.({
                buildId: 'b1',
                ref: 'refs/heads/main',
                sha: 'a'.repeat(40),
                mode: 'build',
            });

            const passed = startBuild.mock.calls[0][0] as { repository: Record<string, unknown> };
            // A private repository routed to a public runner is the failure that
            // matters; a public one on the private runner is only slower.
            expect(passed.repository.visibility).toBe('private');
            // A repository we did not create is not ours to write into, so the
            // workflow change takes the pull-request path. Guessing `true` would
            // push a commit to somebody else's repository.
            expect(passed.repository.createdByAppWork).toBe(false);
        });

        it('uses what the facts source reports when one is bound', async () => {
            const startBuild = jest.fn(async (..._args: unknown[]) => ({
                providerRunId: '1',
                dispatchedAt: '2026-09-21T10:00:00.000Z',
            }));
            const facts: BuildRepositoryFactsSource = {
                getBuildRepositoryFacts: async () => ({
                    visibility: 'public',
                    createdByAppWork: true,
                }),
            };

            const binding = await facade({
                tokens,
                facts,
                plugins: [buildPlugin({ startBuild })],
            }).resolve(WORK_ID, USER_ID);

            await binding?.startBuild?.({
                buildId: 'b1',
                ref: 'refs/heads/main',
                sha: 'a'.repeat(40),
                mode: 'build',
            });

            const passed = startBuild.mock.calls[0][0] as { repository: Record<string, unknown> };
            expect(passed.repository).toMatchObject({
                visibility: 'public',
                createdByAppWork: true,
            });
        });

        it('falls back to the safe answer when the facts source throws', async () => {
            const startBuild = jest.fn(async (..._args: unknown[]) => ({
                providerRunId: '1',
                dispatchedAt: '2026-09-21T10:00:00.000Z',
            }));
            const angry: BuildRepositoryFactsSource = {
                getBuildRepositoryFacts: async () => {
                    throw new Error('upstream state unreadable');
                },
            };

            const binding = await facade({
                tokens,
                facts: angry,
                plugins: [buildPlugin({ startBuild })],
            }).resolve(WORK_ID, USER_ID);

            await binding?.startBuild?.({
                buildId: 'b1',
                ref: 'refs/heads/main',
                sha: 'a'.repeat(40),
                mode: 'build',
            });

            const passed = startBuild.mock.calls[0][0] as { repository: Record<string, unknown> };
            expect(passed.repository).toMatchObject({
                visibility: 'private',
                createdByAppWork: false,
            });
        });
    });

    it('passes the Build through to the plugin, with the optional inputs only when present', async () => {
        const startBuild = jest.fn(async (..._args: unknown[]) => ({
            providerRunId: '9001',
            dispatchedAt: '2026-09-21T10:00:00.000Z',
        }));
        const binding = await facade({ tokens, plugins: [buildPlugin({ startBuild })] }).resolve(
            WORK_ID,
            USER_ID,
        );

        const result = await binding?.startBuild?.({
            buildId: 'b1',
            ref: 'refs/heads/main',
            sha: 'a'.repeat(40),
            mode: 'build',
        });

        expect(result).toEqual({ providerRunId: '9001', dispatchedAt: '2026-09-21T10:00:00.000Z' });
        const passed = startBuild.mock.calls[0][0] as Record<string, unknown>;
        expect(passed.workId).toBe(WORK_ID);
        expect(passed.reuseImageDigest).toBeUndefined();
        expect(passed.verification).toBeUndefined();
        // The credential reaches the plugin as `BuildAuth`, and only there.
        expect(startBuild.mock.calls[0][1]).toEqual({ token: 'ghs-not-a-real-token' });
    });

    it('cancels through the plugin, and is a no-op when the plugin declares no cancel', async () => {
        const cancelBuild = jest.fn(async (..._args: unknown[]) => undefined);
        const withCancel = await facade({
            tokens,
            plugins: [buildPlugin({ cancelBuild })],
        }).resolve(WORK_ID, USER_ID);

        await withCancel?.cancelBuild?.({ buildId: 'b1', providerRunId: '9001' });
        expect(cancelBuild).toHaveBeenCalledTimes(1);

        const without = await facade({
            tokens,
            plugins: [buildPlugin({ cancelBuild: undefined })],
        }).resolve(WORK_ID, USER_ID);

        await expect(
            without?.cancelBuild?.({ buildId: 'b1', providerRunId: '9001' }),
        ).resolves.toBeUndefined();
    });
});
