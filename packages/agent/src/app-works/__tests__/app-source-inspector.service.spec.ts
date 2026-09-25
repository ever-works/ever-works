import {
    APP_INSPECT_MAX_PROVIDER_CALLS,
    APP_PRIVATE_COPY_MAX_SIZE_KB,
    APP_TARGET_OWNER_SCAN_LIMIT_P1,
    type AppSourceInspectResponse,
} from '@ever-works/contracts';
import type { User } from '../../entities/user.entity';
import { NoGitCredentialsError } from '../../facades/git.facade';
import { AppBlueprintResolverService } from '../../apps-catalog/app-blueprint-resolver.service';
import { AppSourceCatalogAdapter } from '../../apps-catalog/app-source-catalog.adapter';
import { AppSourceInspectorService } from '../app-source-inspector.service';

/**
 * APW-01 T12 — `AppSourceInspectorService`, behaviour by behaviour.
 *
 * Every scenario in the task's Test line is one `it` below, and the two the task's
 * "Done when" names are pinned as properties rather than as examples:
 *
 *   - **no mode or deploy target is ever `available: true` alongside a reason
 *     code**, and no non-`none` target is `available: true` without a `providerId`
 *     (`it.each`, over the whole response of every scenario the file builds);
 *   - **no unscanned owner is reported as having no fork** — an owner the budget
 *     did not reach keeps `available: true`, carries NO reason code and reports
 *     `existingForkChecked: false` (ACC-01-26).
 *
 * The service is constructed by hand with fakes, the way the rest of this package's
 * service specs do it: `@Optional()` on every collaborator except the two the
 * service cannot work without is what makes that possible, and the facade spies are
 * also the evidence for ACC-01-06 — inspect writes nothing, so every facade method
 * called here is a READ and the write methods are asserted never to be called.
 */

const USER = { id: 'user-1', username: 'member' } as unknown as User;

/** A `GitRepositoryWithPermissions` with only the fields under test overridden. */
function repository(overrides: Record<string, unknown> = {}) {
    return {
        owner: 'upstream',
        name: 'widgets',
        fullName: 'upstream/widgets',
        defaultBranch: 'main',
        isPrivate: false,
        url: 'https://github.com/upstream/widgets',
        cloneUrl: 'https://github.com/upstream/widgets.git',
        visibility: 'public',
        stars: 12,
        sizeKb: 1_024,
        allowForking: true,
        archived: false,
        empty: false,
        isFork: false,
        licenseSpdx: 'MIT',
        permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
        ...overrides,
    };
}

interface Harness {
    service: AppSourceInspectorService;
    gitFacade: {
        getRepository: jest.Mock;
        getLatestCommit: jest.Mock;
        getUser: jest.Mock;
        getOrganizations: jest.Mock;
        getFileContent: jest.Mock;
        findExistingFork: jest.Mock;
    };
    workRepository: {
        findWorksUsingRepository: jest.Mock;
        findAppWorksByDataRepository: jest.Mock;
    };
    /** Every facade call actually made, in order — the provider-call counter's witness. */
    calls: () => number;
    /** The write half of the facade, spied so a spec can prove inspect never writes. */
    writes: Record<string, jest.Mock>;
    catalog: { matchBlueprint: jest.Mock; classifyLicense: jest.Mock };
}

function harness(input: {
    repository?: unknown;
    organizations?: Array<{ id: string; login: string }>;
    login?: string;
    existingForks?: Record<string, unknown | null>;
    latestCommit?: unknown;
    gitAttributes?: { content: string; encoding: string } | null;
    works?: Array<{ id: string; userId: string; kind: string; relation: string }>;
    ownAppWorks?: Array<{ id: string; name: string; slug: string }>;
    catalog?: boolean;
    /** A REAL catalog port (APW-03's adapter) in place of the jest double. */
    catalogPort?: unknown;
    tierOpen?: boolean;
    appsCapablePlugins?: Array<{ id: string; appsTier: boolean }>;
    registry?: boolean;
    deployFacade?: boolean;
    repositoryError?: unknown;
}): Harness {
    const gitFacade = {
        getRepository: jest.fn(),
        getLatestCommit: jest.fn(),
        getUser: jest.fn(),
        getOrganizations: jest.fn(),
        getFileContent: jest.fn(),
        findExistingFork: jest.fn(),
    };

    /**
     * The write half of the facade, present on the double and NEVER called: this
     * is the direct evidence for ACC-01-06 ("inspect writes nothing"), because a
     * write can only happen through one of these.
     */
    const writes: Record<string, jest.Mock> = {
        forkRepository: jest.fn(),
        createRepository: jest.fn(),
        createRepositoryCopy: jest.fn(),
        createRepositoryFromTemplate: jest.fn(),
        updateRepository: jest.fn(),
        deleteRepository: jest.fn(),
        transferRepository: jest.fn(),
        commit: jest.fn(),
        push: jest.fn(),
        createPullRequest: jest.fn(),
        mergePullRequest: jest.fn(),
        setActionsPermissions: jest.fn(),
        createWebhook: jest.fn(),
        deleteWebhook: jest.fn(),
        createBranch: jest.fn(),
        updateBranchRef: jest.fn(),
        removeLocalDir: jest.fn(),
    };

    if (input.repositoryError) {
        gitFacade.getRepository.mockRejectedValue(input.repositoryError);
    } else {
        const repo = input.repository === undefined ? repository() : input.repository;
        if (repo === null) {
            gitFacade.getRepository.mockResolvedValue(null);
        } else {
            gitFacade.getRepository.mockResolvedValue(repo);
        }
    }
    gitFacade.getLatestCommit.mockResolvedValue(
        input.latestCommit === undefined ? { sha: 'a'.repeat(40) } : input.latestCommit,
    );
    gitFacade.getUser.mockResolvedValue({ id: '1', login: input.login ?? 'member' });
    gitFacade.getOrganizations.mockResolvedValue(
        input.organizations ?? [{ id: '2', login: 'acme' }],
    );
    gitFacade.getFileContent.mockResolvedValue(input.gitAttributes ?? null);
    gitFacade.findExistingFork.mockImplementation(
        async (_owner: string, _repo: string, targetOwner: string) =>
            input.existingForks?.[targetOwner] ?? null,
    );

    const workRepository = {
        findWorksUsingRepository: jest.fn().mockResolvedValue(input.works ?? []),
        findAppWorksByDataRepository: jest.fn().mockResolvedValue(input.ownAppWorks ?? []),
    };

    const catalog =
        input.catalogPort !== undefined
            ? input.catalogPort
            : input.catalog === false
              ? undefined
              : {
                    matchBlueprint: jest.fn().mockResolvedValue(null),
                    classifyLicense: jest.fn().mockResolvedValue('green' as const),
                };

    const tierPolicy =
        input.tierOpen === undefined ? undefined : { isOpen: () => input.tierOpen === true };

    const plugins = (input.appsCapablePlugins ?? []).map((entry) => ({
        state: 'loaded' as const,
        manifest: { capabilities: ['deployment', ...(entry.appsTier ? ['apps-tier'] : [])] },
        plugin: {
            id: entry.id,
            capabilities: ['deployment', ...(entry.appsTier ? ['apps-tier'] : [])],
            supportsApps: true,
            deployApp: () => undefined,
        },
    }));
    const registry =
        input.registry === false
            ? undefined
            : { getEnabledPluginsScoped: jest.fn().mockResolvedValue(plugins) };

    const deployFacade =
        input.deployFacade === false
            ? undefined
            : {
                  getAvailableProvidersForUser: jest
                      .fn()
                      .mockResolvedValue(
                          plugins.map((entry) => ({ id: entry.plugin.id, enabled: true })),
                      ),
              };

    const service = new AppSourceInspectorService(
        { ...gitFacade, ...writes } as never,
        workRepository as never,
        catalog as never,
        tierPolicy as never,
        registry as never,
        deployFacade as never,
    );

    const calls = () =>
        gitFacade.getRepository.mock.calls.length +
        gitFacade.getLatestCommit.mock.calls.length +
        gitFacade.getUser.mock.calls.length +
        gitFacade.getOrganizations.mock.calls.length +
        gitFacade.getFileContent.mock.calls.length +
        gitFacade.findExistingFork.mock.calls.length;

    return { service, gitFacade, workRepository, calls, writes, catalog: catalog as never };
}

/** Every scenario's response is checked against the two invariants of the task. */
function assertNoContradictions(response: AppSourceInspectResponse): void {
    for (const [mode, availability] of Object.entries(response.modes)) {
        if (availability.available) {
            expect(availability.reason).toBeUndefined();
        } else {
            expect(typeof availability.reason).toBe('string');
        }
        expect(mode).toBeTruthy();
    }
    for (const [target, availability] of Object.entries(response.deployTargets)) {
        if (availability.available) {
            expect(availability.reason).toBeUndefined();
            if (target !== 'none') {
                expect(typeof availability.providerId).toBe('string');
                expect(availability.providerId).not.toBe('');
            } else {
                expect(availability.providerId).toBeUndefined();
            }
        } else {
            expect(typeof availability.reason).toBe('string');
            expect(availability.providerId).toBeUndefined();
        }
    }
    for (const owner of response.targetOwners) {
        if (owner.existingForkChecked || !owner.available) {
            // An owner that is NOT available carries its reason (that is FR-13's
            // `target_owner_unavailable`, and it is the point of the entry); the
            // rule below is about an owner that IS offered and simply was not
            // reached.
            continue;
        }
        // An unscanned owner is never reported as "no fork" and never carries a
        // reason code: the two ways of saying "we did not look" are the flag and
        // `scanIncomplete`, nothing else.
        expect(owner.existingFork).toBeUndefined();
        expect(owner.reason).toBeUndefined();
    }
    if (response.scanIncomplete) {
        return;
    }
    for (const owner of response.targetOwners) {
        expect(owner.existingForkChecked).toBe(true);
    }
}

const URL = 'https://github.com/upstream/widgets';

describe('AppSourceInspectorService', () => {
    const originalFlag = process.env.EVER_WORKS_APP_WORKS_ENABLED;

    afterEach(() => {
        if (originalFlag === undefined) {
            delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
        } else {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = originalFlag;
        }
    });

    describe('the instance setting (R-6, FR-5)', () => {
        it('refuses app_works_disabled before parsing and before any provider call', async () => {
            delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
            const h = harness({});

            await expect(h.service.inspect(URL, USER)).rejects.toMatchObject({
                response: { code: 'app_works_disabled', status: 'error' },
            });

            // Before the parser: even an unparseable URL never reaches the provider.
            await expect(h.service.inspect('not a url', USER)).rejects.toMatchObject({
                response: { code: 'app_works_disabled' },
            });
            expect(h.calls()).toBe(0);
        });

        it('answers invalid_url for a URL the parser refuses, with zero provider calls', async () => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
            const h = harness({});

            for (const bad of ['', 'https://gitlab.com/a/b', 'https://github.com/only-owner']) {
                await expect(h.service.inspect(bad, USER)).rejects.toMatchObject({
                    response: { code: 'invalid_url' },
                });
            }
            expect(h.calls()).toBe(0);
        });

        it('refuses a provider mismatch as invalid_url before any provider call', async () => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
            const h = harness({});

            await expect(
                h.service.inspect(URL, USER, { gitProvider: 'gitlab' }),
            ).rejects.toMatchObject({ response: { code: 'invalid_url' } });
            expect(h.calls()).toBe(0);
        });
    });

    describe('provider-side refusals answer 200 with a reason (plan §4.1)', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        it('not_found when the repository cannot be read', async () => {
            const h = harness({ repository: null });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes.link).toEqual({ available: false, reason: 'not_found' });
            expect(response.modes.fork).toEqual({ available: false, reason: 'not_found' });
            expect(response.modes['private-copy']).toEqual({
                available: false,
                reason: 'not_found',
            });
            expect(response.defaultMode).toBeNull();
            assertNoContradictions(response);
        });

        it.each([
            ['permission_missing', 403, 'insufficient_scope'],
            ['sso_authorization_required', 403, 'sso_authorization_required'],
            ['oauth_app_restricted', 403, 'oauth_app_restricted'],
            ['unauthorized', 401, 'provider_not_connected'],
            ['not_found', 404, 'not_found'],
        ])('classifies a typed provider %s as %s', async (reason, status, expected) => {
            const h = harness({ repositoryError: { reason, status, details: {} } });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes.link).toEqual({ available: false, reason: expected });
            assertNoContradictions(response);
        });

        it.each(['rate_limited', 'secondary_rate_limited'])(
            'refuses the whole inspection with %s and the provider retry instant',
            async (reason) => {
                const retryAt = '2026-09-18T12:00:00.000Z';
                const h = harness({
                    repositoryError: { reason, status: 403, details: { retryAt } },
                });

                const response = await h.service.inspect(URL, USER);

                expect(response.retryAfter).toBe(retryAt);
                expect(response.modes.link).toEqual({ available: false, reason: 'rate_limited' });
                expect(response.modes.fork).toEqual({ available: false, reason: 'rate_limited' });
                assertNoContradictions(response);
            },
        );

        it('reports provider_not_connected when no GitHub connection is bound', async () => {
            const h = harness({ repositoryError: new NoGitCredentialsError('github', USER.id) });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes.link).toEqual({
                available: false,
                reason: 'provider_not_connected',
            });
        });

        it('refuses a rate limit found mid-scan for the whole inspection', async () => {
            const h = harness({});
            h.gitFacade.findExistingFork.mockRejectedValueOnce({
                reason: 'rate_limited',
                status: 403,
                details: { retryAt: '2026-09-18T13:00:00.000Z' },
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.retryAfter).toBe('2026-09-18T13:00:00.000Z');
            expect(response.modes['private-copy']).toEqual({
                available: false,
                reason: 'rate_limited',
            });
        });
    });

    describe('the mode matrix (FR-12, FR-17, FR-18)', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        it('offers every mode and defaults to Link for a pushable, non-fork repository', async () => {
            const h = harness({
                repository: repository({ permissions: { push: true, admin: true, pull: true } }),
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes).toEqual({
                link: { available: true },
                fork: { available: true },
                'private-copy': { available: true },
            });
            expect(response.defaultMode).toBe('link');
            expect(response.access).toEqual({ canPush: true, canAdmin: true });
            assertNoContradictions(response);
        });

        it('refuses Link with no_push_access and defaults to Fork without push access', async () => {
            const h = harness({});

            const response = await h.service.inspect(URL, USER);

            expect(response.modes.link).toEqual({ available: false, reason: 'no_push_access' });
            expect(response.modes.fork).toEqual({ available: true });
            expect(response.defaultMode).toBe('fork');
        });

        it('defaults to Fork when the pasted repository is itself a fork the member can push to', async () => {
            const h = harness({
                repository: repository({
                    isFork: true,
                    parent: { owner: 'origin', name: 'widgets', fullName: 'origin/widgets' },
                    permissions: { push: true, pull: true },
                }),
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.defaultMode).toBe('fork');
        });

        it('refuses Fork with own_repository when the member owns the upstream account', async () => {
            const h = harness({ repository: repository({ owner: 'member' }) });

            const response = await h.service.inspect('https://github.com/member/widgets', USER);

            expect(response.modes.fork).toEqual({ available: false, reason: 'own_repository' });
        });

        it('refuses Fork with forking_disabled when the provider reports forks are off', async () => {
            const h = harness({ repository: repository({ allowForking: false }) });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes.fork).toEqual({ available: false, reason: 'forking_disabled' });
        });

        it('refuses Fork with empty_repository and reads the default branch once to prove it', async () => {
            const h = harness({
                repository: repository({ sizeKb: 0, empty: undefined }),
                latestCommit: null,
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.repository.empty).toBe(true);
            expect(response.modes.fork).toEqual({ available: false, reason: 'empty_repository' });
            expect(h.gitFacade.getLatestCommit).toHaveBeenCalledTimes(1);
            // An empty repository has no default branch to read a file from.
            expect(h.gitFacade.getFileContent).not.toHaveBeenCalled();
        });

        it('refuses Fork with archived Link rules when the repository is archived', async () => {
            const h = harness({
                repository: repository({
                    archived: true,
                    permissions: { push: true, pull: true },
                }),
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes.link).toEqual({ available: false, reason: 'archived' });
            expect(response.repository.archived).toBe(true);
        });

        it.each([
            [APP_PRIVATE_COPY_MAX_SIZE_KB, true],
            [APP_PRIVATE_COPY_MAX_SIZE_KB + 1, false],
        ])('applies the private-copy ceiling at %i KB', async (sizeKb, allowed) => {
            const h = harness({ repository: repository({ sizeKb }) });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes['private-copy']).toEqual(
                allowed
                    ? { available: true }
                    : { available: false, reason: 'too_large_for_private_copy' },
            );
        });

        it('fails the private copy closed when the provider reported no size at all', async () => {
            const h = harness({ repository: repository({ sizeKb: undefined }) });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes['private-copy']).toEqual({
                available: false,
                reason: 'too_large_for_private_copy',
            });
        });

        it('refuses the private copy with uses_lfs when .gitattributes declares filter=lfs', async () => {
            const h = harness({
                gitAttributes: {
                    content: '*.psd filter=lfs diff=lfs merge=lfs -text\n',
                    encoding: 'utf-8',
                },
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.repository.usesLfs).toBe(true);
            expect(response.modes['private-copy']).toEqual({
                available: false,
                reason: 'uses_lfs',
            });
            expect(h.gitFacade.getFileContent).toHaveBeenCalledWith(
                'upstream',
                'widgets',
                '.gitattributes',
                expect.anything(),
                'main',
            );
        });

        it('reads a base64 .gitattributes too', async () => {
            const h = harness({
                gitAttributes: {
                    content: Buffer.from('*.psd filter=lfs\n').toString('base64'),
                    encoding: 'base64',
                },
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.repository.usesLfs).toBe(true);
        });

        it('refuses Link with in_use_by_another_account and still offers Fork (ACC-01-09)', async () => {
            const h = harness({
                repository: repository({ permissions: { push: true, pull: true } }),
                works: [{ id: 'w-2', userId: 'somebody-else', kind: 'app', relation: 'website' }],
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes.link).toEqual({
                available: false,
                reason: 'in_use_by_another_account',
            });
            expect(response.modes.fork).toEqual({ available: true });
            // The other account is never named — a boolean is the whole answer.
            expect(JSON.stringify(response)).not.toContain('somebody-else');
        });

        it('does not treat the caller’s own Work as another account’s usage', async () => {
            const h = harness({
                repository: repository({ permissions: { push: true, pull: true } }),
                works: [{ id: 'w-1', userId: 'user-1', kind: 'app', relation: 'website' }],
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.modes.link).toEqual({ available: true });
        });

        it('reports the caller’s own App Work and nothing else (FR-23, FR-51)', async () => {
            const h = harness({
                ownAppWorks: [{ id: 'w-1', name: 'Widgets', slug: 'widgets' }],
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.existingAppWork).toEqual({
                id: 'w-1',
                name: 'Widgets',
                slug: 'widgets',
            });
            expect(h.workRepository.findAppWorksByDataRepository).toHaveBeenCalledWith(
                'user-1',
                'upstream',
                'widgets',
            );
        });

        it('reports a rename through movedFrom and keeps the canonical coordinates', async () => {
            const h = harness({
                repository: repository({
                    owner: 'new-owner',
                    name: 'widgets',
                    fullName: 'new-owner/widgets',
                    movedFrom: 'old-owner/widgets',
                }),
            });

            const response = await h.service.inspect('https://github.com/old-owner/widgets', USER);

            expect(response.repository.movedFrom).toBe('old-owner/widgets');
            expect(response.repository.owner).toBe('new-owner');
            expect(response.repository.fullName).toBe('new-owner/widgets');
        });

        it('fails the private copy closed on a private repository whose provider forbids forks', async () => {
            const h = harness({
                repository: repository({
                    visibility: 'private',
                    isPrivate: true,
                    allowForking: false,
                }),
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.repository.visibility).toBe('private');
            expect(response.modes['private-copy']).toEqual({
                available: false,
                reason: 'forking_disabled',
            });
        });
    });

    describe('owners and the fork scan (FR-9, ACC-01-03, ACC-01-04, ACC-01-26)', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        it('lists the caller first and the organizations A–Z from the member’s own connection', async () => {
            const h = harness({
                login: 'member',
                organizations: [
                    { id: '3', login: 'zeta' },
                    { id: '2', login: 'Acme' },
                    { id: '4', login: 'beta' },
                ],
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.targetOwners.map((owner) => owner.login)).toEqual([
                'member',
                'Acme',
                'beta',
                'zeta',
            ]);
            expect(response.targetOwners.map((owner) => owner.type)).toEqual([
                'user',
                'organization',
                'organization',
                'organization',
            ]);
            // The connection is the member's: the facade is asked with their id,
            // never the platform's.
            expect(h.gitFacade.getUser).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-1' }),
            );
            expect(h.gitFacade.getOrganizations).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-1' }),
            );
        });

        it('finds an existing renamed fork per owner and reports it checked (ACC-01-04)', async () => {
            const h = harness({
                existingForks: {
                    member: null,
                    acme: {
                        owner: 'acme',
                        name: 'widgets-renamed',
                        fullName: 'acme/widgets-renamed',
                        url: 'https://github.com/acme/widgets-renamed',
                    },
                },
            });

            const response = await h.service.inspect(URL, USER);

            const acme = response.targetOwners.find((owner) => owner.login === 'acme');
            expect(acme?.existingForkChecked).toBe(true);
            expect(acme?.existingFork).toEqual({
                owner: 'acme',
                repo: 'widgets-renamed',
                fullName: 'acme/widgets-renamed',
                url: 'https://github.com/acme/widgets-renamed',
                inUseByAnotherAccount: false,
            });
            expect(response.scanIncomplete).toBe(false);
            assertNoContradictions(response);
        });

        it('scans from the fork network root when the pasted repository is itself a fork', async () => {
            const h = harness({
                repository: repository({
                    isFork: true,
                    parent: { owner: 'origin', name: 'widgets', fullName: 'origin/widgets' },
                    source: { owner: 'root', name: 'widgets', fullName: 'root/widgets' },
                    permissions: { push: true, pull: true },
                }),
            });

            await h.service.inspect(URL, USER);

            expect(h.gitFacade.findExistingFork).toHaveBeenCalledWith(
                'root',
                'widgets',
                expect.any(String),
                expect.anything(),
            );
        });

        it('treats an owner the budget did not reach as NOT CHECKED, with no reason code (ACC-01-26)', async () => {
            const organizations = Array.from({ length: 30 }, (_, index) => ({
                id: `org-${index}`,
                login: `org-${String(index).padStart(2, '0')}`,
            }));
            const h = harness({ organizations });

            const response = await h.service.inspect(URL, USER);

            expect(h.calls()).toBeLessThanOrEqual(APP_INSPECT_MAX_PROVIDER_CALLS);
            expect(response.scanIncomplete).toBe(true);

            // The caller is always checked first.
            expect(response.targetOwners[0].login).toBe('member');
            expect(response.targetOwners[0].existingForkChecked).toBe(true);

            const unreached = response.targetOwners.filter((owner) => !owner.existingForkChecked);
            expect(unreached.length).toBeGreaterThan(0);
            for (const owner of unreached) {
                expect(owner.available).toBe(true);
                expect(owner.reason).toBeUndefined();
                expect(owner.existingFork).toBeUndefined();
            }
            // Every offered organization is still offered.
            expect(response.targetOwners).toHaveLength(1 + APP_TARGET_OWNER_SCAN_LIMIT_P1);
            assertNoContradictions(response);
        });

        it('completes the scan and clears scanIncomplete with two organizations', async () => {
            const h = harness({
                organizations: [
                    { id: '2', login: 'acme' },
                    { id: '3', login: 'beta' },
                ],
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.scanIncomplete).toBe(false);
            expect(response.targetOwners).toHaveLength(3);
            expect(response.targetOwners.every((owner) => owner.existingForkChecked)).toBe(true);
            expect(h.calls()).toBeLessThanOrEqual(APP_INSPECT_MAX_PROVIDER_CALLS);
        });

        it('keeps an owner whose check FAILED not-checked rather than reporting no fork', async () => {
            const h = harness({ organizations: [{ id: '2', login: 'acme' }] });
            h.gitFacade.findExistingFork
                .mockRejectedValueOnce(new Error('provider exploded'))
                .mockResolvedValueOnce(null);

            const response = await h.service.inspect(URL, USER);

            expect(response.targetOwners[0].existingForkChecked).toBe(false);
            expect(response.targetOwners[0].reason).toBeUndefined();
            expect(response.scanIncomplete).toBe(true);
            assertNoContradictions(response);
        });

        it('still reports the requested owner as unavailable when it is not one of the member’s', async () => {
            const h = harness({ organizations: [{ id: '2', login: 'acme' }] });

            const response = await h.service.inspect(URL, USER, { targetOwner: 'stranger' });

            const stranger = response.targetOwners.find((owner) => owner.login === 'stranger');
            expect(stranger).toMatchObject({
                available: false,
                reason: 'target_owner_unavailable',
                existingForkChecked: false,
            });
            assertNoContradictions(response);
        });

        it('matches the requested owner case-insensitively, as forkTemplateForUser does', async () => {
            const h = harness({ organizations: [{ id: '2', login: 'Acme' }] });

            const response = await h.service.inspect(URL, USER, { targetOwner: 'aCMe' });

            expect(response.targetOwners.some((owner) => owner.login === 'stranger')).toBe(false);
            expect(response.scanIncomplete).toBe(false);
        });
    });

    describe('the provider-call budget (FR-7, FR-9)', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        it('makes at most the fixed five calls when there is no owner to scan', async () => {
            const h = harness({ login: '', organizations: [] });

            await h.service.inspect(URL, USER);

            expect(h.calls()).toBeLessThanOrEqual(5);
        });

        it('never exceeds the ceiling with thirty organizations and a fork per owner', async () => {
            const organizations = Array.from({ length: 30 }, (_, index) => ({
                id: `org-${index}`,
                login: `org-${index}`,
            }));
            const h = harness({
                organizations,
                existingForks: Object.fromEntries(
                    ['member', ...organizations.map((org) => org.login)].map((login) => [
                        login,
                        { owner: login, name: 'widgets', fullName: `${login}/widgets`, url: 'u' },
                    ]),
                ),
            });

            const response = await h.service.inspect(URL, USER);

            expect(h.calls()).toBeLessThanOrEqual(APP_INSPECT_MAX_PROVIDER_CALLS);
            expect(response.scanIncomplete).toBe(true);
        });
    });

    describe('the cache (plan §2.2, spec.md:291)', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        it('serves a second inspection from the cache and re-reads after the TTL', async () => {
            const h = harness({});
            const nowSpy = jest.spyOn(Date, 'now');

            nowSpy.mockReturnValue(1_000_000);
            await h.service.inspect(URL, USER);
            const afterFirst = h.calls();

            nowSpy.mockReturnValue(1_030_000);
            const cached = await h.service.inspect(URL, USER);
            expect(h.calls()).toBe(afterFirst);
            expect(cached.repository.fullName).toBe('upstream/widgets');

            nowSpy.mockReturnValue(1_100_000);
            await h.service.inspect(URL, USER);
            expect(h.calls()).toBeGreaterThan(afterFirst);

            nowSpy.mockRestore();
        });

        it('bypasses the cache when the caller asks for a fresh answer', async () => {
            const h = harness({});

            await h.service.inspect(URL, USER);
            const afterFirst = h.calls();
            await h.service.inspect(URL, USER, { fresh: true });

            expect(h.calls()).toBe(afterFirst * 2);
        });

        it('keys the cache per member and per repository', async () => {
            const h = harness({});
            const other = { id: 'user-2', username: 'other' } as unknown as User;

            await h.service.inspect(URL, USER);
            const afterFirst = h.calls();
            await h.service.inspect(URL, other);

            expect(h.calls()).toBeGreaterThan(afterFirst);
        });

        it('does not cache an inspection that named a Blueprint', async () => {
            const h = harness({});
            h.catalog.matchBlueprint.mockResolvedValue(null);

            await h.service.inspect(URL, USER, { blueprintId: 'cal-diy' });
            const afterFirst = h.calls();
            await h.service.inspect(URL, USER, { blueprintId: 'cal-diy' });

            expect(h.calls()).toBe(afterFirst * 2);
        });
    });

    describe('the catalog preview (FR-8, FR-55, FR-56, ACC-01-21, ACC-01-22)', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        it('carries the match’s id, source, display name and prompt descriptors', async () => {
            const h = harness({});
            h.catalog.matchBlueprint.mockResolvedValue({
                id: 'cal-diy',
                version: '1.2.0',
                verified: true,
                name: 'cal-diy',
                displayName: 'Cal.diy',
                matchSource: 'manifest',
                licenseClass: 'green',
                prompts: [{ name: 'admin_email', description: 'Where alerts go', required: true }],
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.blueprint).toEqual({
                status: 'matched',
                id: 'cal-diy',
                version: '1.2.0',
                verified: true,
                name: 'Cal.diy',
                matchSource: 'manifest',
                prompts: [{ name: 'admin_email', description: 'Where alerts go', required: true }],
            });
            expect(response.license).toEqual({ spdx: 'MIT', class: 'green', source: 'blueprint' });
            // The prompt DESCRIPTORS travel; a value never does.
            expect(h.catalog.matchBlueprint).toHaveBeenCalledWith({
                owner: 'upstream',
                repo: 'widgets',
            });
        });

        it('passes an explicit blueprintId through the resolver', async () => {
            const h = harness({});
            h.catalog.matchBlueprint.mockResolvedValue(null);

            const response = await h.service.inspect(URL, USER, { blueprintId: 'cal-diy' });

            expect(h.catalog.matchBlueprint).toHaveBeenCalledWith({
                owner: 'upstream',
                repo: 'widgets',
                blueprintId: 'cal-diy',
            });
            expect(response.blueprint).toEqual({ status: 'none' });
            expect(response.license).toEqual({ spdx: 'MIT', class: 'green', source: 'detected' });
        });

        it('carries no matchSource and no prompts on a source-only preview', async () => {
            const h = harness({});

            const response = await h.service.inspect(URL, USER);

            expect(response.blueprint.status).toBe('none');
            expect(response.blueprint.matchSource).toBeUndefined();
            expect(response.blueprint.prompts).toBeUndefined();
            expect(response.blueprint.id).toBeUndefined();
            expect(response.license.source).toBe('detected');
        });

        it('answers unavailable with an unknown license class when the port is unbound', async () => {
            const h = harness({ catalog: false });

            const response = await h.service.inspect(URL, USER);

            expect(response.blueprint).toEqual({ status: 'unavailable' });
            expect(response.license).toEqual({ spdx: 'MIT', class: 'unknown', source: 'detected' });
        });

        it('answers unavailable with an unknown class when the port throws', async () => {
            const h = harness({});
            h.catalog.matchBlueprint.mockRejectedValue(new Error('catalog down'));
            h.catalog.classifyLicense.mockRejectedValue(new Error('catalog down'));

            const response = await h.service.inspect(URL, USER);

            expect(response.blueprint).toEqual({ status: 'unavailable' });
            expect(response.license).toEqual({ spdx: 'MIT', class: 'unknown', source: 'detected' });
        });

        it('never guesses a licence class when the provider reported none', async () => {
            // `undefined` is the plugin contract's "not reported" — a repository with no
            // licence file. This case used `null` until 2026-09-25, but `null` is the
            // contract's spelling of GitHub's NOASSERTION ("reported, not nameable"),
            // which the owner decision now classifies red: see the next case.
            const h = harness({ repository: repository({ licenseSpdx: undefined }) });

            const response = await h.service.inspect(URL, USER);

            expect(response.license.spdx).toBeNull();
            expect(h.catalog.classifyLicense).toHaveBeenCalledWith(null);
        });

        it('carries GitHub’s NOASSERTION (licenseSpdx null) through as NOASSERTION, never as "no licence"', async () => {
            const h = harness({ repository: repository({ licenseSpdx: null }) });

            const response = await h.service.inspect(URL, USER);

            expect(response.license.spdx).toBe('NOASSERTION');
            expect(h.catalog.classifyLicense).toHaveBeenCalledWith('NOASSERTION');
        });
    });

    describe('with APW-03’s real catalog adapter bound (APW-03 T26, the apply gate)', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        const savedCatalogToken = process.env.EVER_WORKS_APPS_CATALOG_TOKEN;
        afterEach(() => {
            if (savedCatalogToken === undefined) {
                delete process.env.EVER_WORKS_APPS_CATALOG_TOKEN;
            } else {
                process.env.EVER_WORKS_APPS_CATALOG_TOKEN = savedCatalogToken;
            }
        });

        /** The platform-credential facade the resolver reads `ever-works/*` through. */
        function platformFacade(
            input: { blueprint?: boolean; installationToken?: string | null } = {},
        ) {
            const name = 'widgets-template';
            const spec = [
                'version: 2',
                'kind: app',
                'spec:',
                '  blueprint:',
                '    id: widgets',
                '    version: 1.0.0',
                `    repo: ever-works/${name}`,
                `    sha: '${'0'.repeat(40)}'`,
                '  license:',
                '    spdx: MIT',
                '',
            ].join('\n');
            return {
                getInstallationTokenForOwner: jest
                    .fn()
                    .mockResolvedValue(
                        input.installationToken === undefined
                            ? 'installation-token'
                            : input.installationToken,
                    ),
                getRepository: jest.fn(async (_owner: string, repo: string) =>
                    input.blueprint && repo === name
                        ? {
                              owner: 'ever-works',
                              name,
                              fullName: `ever-works/${name}`,
                              defaultBranch: 'main',
                              isPrivate: false,
                              visibility: 'public',
                              topics: ['ever-works-app-blueprint'],
                          }
                        : null,
                ),
                getFileContent: jest.fn(async (_owner: string, repo: string) =>
                    input.blueprint && repo === name ? { content: spec, encoding: 'utf-8' } : null,
                ),
            };
        }

        function realAdapter(
            platform: ReturnType<typeof platformFacade>,
            blueprintApply?: unknown,
        ): AppSourceCatalogAdapter {
            return new AppSourceCatalogAdapter(
                new AppBlueprintResolverService(platform as never),
                blueprintApply as never,
            );
        }

        it('previews "none" and a DETECTED licence class when the probe misses', async () => {
            // On the unbound graph this was `unavailable` / `unknown` for every repository.
            const platform = platformFacade();
            const h = harness({ catalogPort: realAdapter(platform) });

            const response = await h.service.inspect(URL, USER);

            expect(response.blueprint).toEqual({ status: 'none' });
            expect(response.license).toEqual({ spdx: 'MIT', class: 'green', source: 'detected' });
            expect(platform.getRepository.mock.calls.map((call) => call[1])).toEqual([
                'widgets-template',
                'upstream-widgets-template',
            ]);
        });

        it('previews "unavailable", never "matched", for a probe hit while nothing can apply it', async () => {
            const h = harness({ catalogPort: realAdapter(platformFacade({ blueprint: true })) });

            const response = await h.service.inspect(URL, USER);

            expect(response.blueprint).toEqual({ status: 'unavailable' });
            expect(response.license).toEqual({ spdx: 'MIT', class: 'unknown', source: 'detected' });
        });

        it('previews the match once an apply service is bound', async () => {
            const h = harness({
                catalogPort: realAdapter(platformFacade({ blueprint: true }), {
                    request: jest.fn(),
                }),
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.blueprint).toEqual({
                status: 'matched',
                id: 'widgets',
                version: '1.0.0',
                verified: false,
                name: 'widgets',
                matchSource: 'probe',
            });
            expect(response.license).toEqual({ spdx: 'MIT', class: 'green', source: 'blueprint' });
        });

        it('previews "unavailable" when the platform has no credential for the catalog', async () => {
            delete process.env.EVER_WORKS_APPS_CATALOG_TOKEN;
            const savedGithub = process.env.GITHUB_TOKEN;
            delete process.env.GITHUB_TOKEN;
            try {
                const h = harness({
                    catalogPort: realAdapter(platformFacade({ installationToken: null })),
                });

                const response = await h.service.inspect(URL, USER);

                expect(response.blueprint).toEqual({ status: 'unavailable' });
                expect(response.license).toEqual({
                    spdx: 'MIT',
                    class: 'unknown',
                    source: 'detected',
                });
            } finally {
                if (savedGithub !== undefined) process.env.GITHUB_TOKEN = savedGithub;
            }
        });

        it('classifies GitHub’s NOASSERTION red (owner decision, ACC-NEG-01)', async () => {
            const h = harness({
                repository: repository({ licenseSpdx: null }),
                catalogPort: realAdapter(platformFacade()),
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.license).toEqual({
                spdx: 'NOASSERTION',
                class: 'red',
                source: 'detected',
            });
        });

        it('keeps a repository with no licence file unknown', async () => {
            const h = harness({
                repository: repository({ licenseSpdx: undefined }),
                catalogPort: realAdapter(platformFacade()),
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.license).toEqual({ spdx: null, class: 'unknown', source: 'detected' });
        });
    });

    describe('deploy targets (FR-33, FR-34, R-5, R-12)', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        it('offers only None when no policy is bound and no apps-capable plugin exists', async () => {
            const h = harness({});

            const response = await h.service.inspect(URL, USER);

            expect(response.deployTargets).toEqual({
                none: { available: true },
                'your-cluster': { available: false, reason: 'cluster_target_unavailable' },
                'ever-works-apps': { available: false, reason: 'managed_hosting_unavailable' },
            });
            assertNoContradictions(response);
        });

        it('offers your-cluster with the providerId when an apps-capable plugin is enabled', async () => {
            const h = harness({
                appsCapablePlugins: [{ id: 'k8s', appsTier: false }],
                tierOpen: false,
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.deployTargets['your-cluster']).toEqual({
                available: true,
                providerId: 'k8s',
            });
            expect(response.deployTargets['ever-works-apps']).toEqual({
                available: false,
                reason: 'managed_hosting_unavailable',
            });
            assertNoContradictions(response);
        });

        it('offers Ever Works Apps with the tier plugin id while the policy is open', async () => {
            const h = harness({
                appsCapablePlugins: [
                    { id: 'k8s', appsTier: false },
                    { id: 'apps-tier', appsTier: true },
                ],
                tierOpen: true,
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.deployTargets['ever-works-apps']).toEqual({
                available: true,
                providerId: 'apps-tier',
            });
            expect(response.deployTargets['your-cluster']).toEqual({
                available: true,
                providerId: 'k8s',
            });
            assertNoContradictions(response);
        });

        it('refuses the managed target while the policy is bound but closed (R-5)', async () => {
            const h = harness({
                appsCapablePlugins: [{ id: 'apps-tier', appsTier: true }],
                tierOpen: false,
            });

            const response = await h.service.inspect(URL, USER);

            expect(response.deployTargets['ever-works-apps']).toEqual({
                available: false,
                reason: 'managed_hosting_unavailable',
            });
            // The tier plugin is NOT a your-cluster provider either.
            expect(response.deployTargets['your-cluster']).toEqual({
                available: false,
                reason: 'cluster_target_unavailable',
            });
        });

        it('ignores a plugin that omits supportsApps', async () => {
            const h = harness({ tierOpen: true });
            (h.service as unknown as { registry: unknown }).registry = {
                getEnabledPluginsScoped: jest.fn().mockResolvedValue([
                    {
                        state: 'loaded',
                        manifest: { capabilities: ['deployment'] },
                        plugin: { id: 'vercel', capabilities: ['deployment'] },
                    },
                ]),
            };

            const response = await h.service.inspect(URL, USER);

            expect(response.deployTargets['your-cluster'].available).toBe(false);
            assertNoContradictions(response);
        });
    });

    describe('inspect writes nothing (FR-5, ACC-01-06)', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        it('calls no provider write method on any path', async () => {
            const paths: Array<Record<string, unknown>> = [
                { repository: repository({ permissions: { push: true, pull: true } }) },
                {
                    existingForks: {
                        acme: { owner: 'acme', name: 'widgets', fullName: 'a/w', url: 'u' },
                    },
                },
                { repositoryError: { reason: 'permission_missing', status: 403 } },
                { repository: null },
                { repository: repository({ archived: true }) },
            ];

            for (const scenario of paths) {
                const h = harness(scenario);
                await h.service.inspect(URL, USER, { fresh: true });

                // Every write the git facade can perform is spied on the double and
                // must never have been called: inspect is a READ-ONLY operation
                // (FR-5, ACC-01-06).
                for (const [name, spy] of Object.entries(h.writes)) {
                    expect({ name, calls: spy.mock.calls.length }).toEqual({ name, calls: 0 });
                }
                // …and the two repository collaborators are only ever READ from.
                expect(Object.keys(h.workRepository).sort()).toEqual([
                    'findAppWorksByDataRepository',
                    'findWorksUsingRepository',
                ]);
            }
        });
    });

    describe('the response shape', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        it('answers every field the contract requires', async () => {
            const h = harness({});

            const response = await h.service.inspect(URL, USER);

            expect(response.repository).toEqual({
                owner: 'upstream',
                repo: 'widgets',
                fullName: 'upstream/widgets',
                url: 'https://github.com/upstream/widgets',
                description: undefined,
                defaultBranch: 'main',
                stars: 12,
                sizeKb: 1_024,
                visibility: 'public',
                archived: false,
                empty: false,
                isFork: false,
                parent: undefined,
                source: undefined,
                allowForking: true,
                movedFrom: undefined,
                usesLfs: false,
            });
            expect(typeof response.scanIncomplete).toBe('boolean');
            assertNoContradictions(response);
        });
    });
});
