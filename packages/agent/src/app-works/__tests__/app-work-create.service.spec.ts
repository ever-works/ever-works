import {
    APP_CREATE_IDEMPOTENCY_WINDOW_MS,
    type AppSourceInspectResponse,
} from '@ever-works/contracts';
import type { User } from '../../entities/user.entity';
import type { Work } from '../../entities/work.entity';
import { AppWorkCreateService } from '../app-work-create.service';

/**
 * APW-01 T13 — `AppWorkCreateService`, the whole refusal matrix and the whole
 * persistence contract.
 *
 * The file is organised the way the task's Test line is: the refusals first (each
 * one proving that NOTHING was written), then the three relations, then the
 * transaction, then the two background/telemetry seams, then the three field-level
 * rules (`autoProvision`, the Blueprint matrix, the deploy target).
 *
 * Two properties are asserted on EVERY scenario rather than as examples:
 *
 *   - **a refusal writes nothing**: every git-facade write spy and both repository
 *     writers are asserted to have zero calls, and no `withTransaction` happened;
 *   - **`createWork`'s return shape** carries the relation, the readiness, the Work
 *     Repository, the upstream (for a fork or copy), the resolved deploy target and
 *     the Blueprint the platform settled.
 */

const USER = { id: 'user-1', username: 'member', email: 'member@example.com' } as unknown as User;
const UPSTREAM_URL = 'https://github.com/upstream/widgets';
/** The manager sentinel: identity is all the assertions need. */
const MANAGER = { marker: 'transaction-manager' } as never;

function dto(overrides: Record<string, unknown> = {}) {
    return {
        slug: 'widgets',
        name: 'Widgets',
        description: 'A widgets app',
        organization: false,
        gitProvider: 'github',
        repositoryUrl: UPSTREAM_URL,
        kind: 'app',
        repositoryMode: 'fork',
        targetOwner: 'member',
        ...overrides,
    } as never;
}

/** A canned inspection, with only the fields a scenario cares about overridden. */
function inspectResponse(overrides: Record<string, unknown> = {}): AppSourceInspectResponse {
    return {
        repository: {
            owner: 'upstream',
            repo: 'widgets',
            fullName: 'upstream/widgets',
            url: UPSTREAM_URL,
            defaultBranch: 'main',
            stars: 5,
            sizeKb: 100,
            visibility: 'public',
            archived: false,
            empty: false,
            isFork: false,
            allowForking: true,
            usesLfs: false,
        },
        access: { canPush: false, canAdmin: false },
        modes: {
            link: { available: false, reason: 'no_push_access' },
            fork: { available: true },
            'private-copy': { available: true },
        },
        defaultMode: 'fork',
        targetOwners: [
            { login: 'member', type: 'user', available: true, existingForkChecked: true },
            { login: 'acme', type: 'organization', available: true, existingForkChecked: true },
        ],
        blueprint: { status: 'none' },
        license: { spdx: 'MIT', class: 'green', source: 'detected' },
        deployTargets: {
            none: { available: true },
            'your-cluster': { available: true, providerId: 'k8s' },
            'ever-works-apps': { available: false, reason: 'managed_hosting_unavailable' },
        },
        scanIncomplete: false,
        ...overrides,
    } as unknown as AppSourceInspectResponse;
}

interface Harness {
    service: AppWorkCreateService;
    inspector: { inspect: jest.Mock };
    locks: { runExclusive: jest.Mock };
    gitFacade: Record<string, jest.Mock>;
    deployFacade: { getAvailableProvidersForUser: jest.Mock };
    workRepository: Record<string, jest.Mock>;
    workUpstreamStates: Record<string, jest.Mock>;
    eventEmitter: { emitAsync: jest.Mock };
    dispatcher: { dispatch: jest.Mock };
    catalog: { matchBlueprint: jest.Mock; classifyLicense: jest.Mock };
    promptedValues: { storePrompted: jest.Mock };
    registry: { getEnabledPluginsScoped: jest.Mock };
    /** Every write the create path could make, so a refusal can prove it made none. */
    writes: () => Array<{ name: string; calls: number }>;
}

function harness(
    input: {
        inspect?: AppSourceInspectResponse;
        inspectError?: unknown;
        forkResult?: unknown;
        existingRepository?: unknown;
        existingForks?: Array<{ owner: string; repo: string }>;
        ownAppWorks?: unknown[];
        lockAcquired?: boolean;
        slugTaken?: boolean;
        /**
         * The Work `WorkRepository.findByOwnerAndSlug` answers for the taken slug
         * (C9 / FR-23): step 5 reads it to decide whether the collision is the one
         * FR-23 answers idempotently. `null` (the default) is a holder that
         * vanished between the count and the read.
         */
        slugHolder?: unknown;
        transactionError?: unknown;
        dispatcherResult?: string | null;
        dispatcherExplodes?: boolean;
        tierOpen?: boolean;
        appsTierPluginId?: string | null;
        providers?: Array<{ id: string; enabled: boolean }>;
        catalog?: boolean;
        promptedValues?: boolean;
        appWorksEnabled?: boolean;
    } = {},
): Harness {
    if (input.appWorksEnabled === false) {
        delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
    } else {
        process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
    }

    const inspector = {
        inspect: input.inspectError
            ? jest.fn().mockRejectedValue(input.inspectError)
            : jest.fn().mockResolvedValue(input.inspect ?? inspectResponse()),
    };

    const locks = {
        runExclusive: jest.fn(
            async (_key: string, fn: () => Promise<unknown>, _options?: unknown) =>
                input.lockAcquired === false
                    ? { acquired: false }
                    : { acquired: true, result: await fn() },
        ),
    };

    const createdWork = {
        id: 'work-1',
        slug: 'widgets',
        name: 'Widgets',
        owner: 'member',
        userId: USER.id,
        kind: 'app',
        createdAt: new Date(),
        sourceRepository: {
            url: 'https://github.com/member/widgets',
            owner: 'member',
            repo: 'widgets',
            type: 'app_fork',
            importedAt: new Date(),
            relatedRepositories: { website: { owner: 'member', repo: 'widgets' } },
        },
    } as unknown as Work;

    const gitFacade: Record<string, jest.Mock> = {
        getRepository: jest.fn().mockResolvedValue(input.existingRepository ?? null),
        getUser: jest.fn().mockResolvedValue({ id: '1', login: 'member' }),
        getOrganizations: jest.fn().mockResolvedValue([{ id: '2', login: 'acme' }]),
        getFileContent: jest.fn().mockResolvedValue(null),
        getLatestCommit: jest.fn().mockResolvedValue({ sha: 'a'.repeat(40) }),
        findExistingFork: jest.fn().mockResolvedValue(null),
        forkRepository: jest.fn().mockResolvedValue(
            input.forkResult ?? {
                owner: 'member',
                name: 'widgets',
                fullName: 'member/widgets',
                defaultBranch: 'main',
                url: 'https://github.com/member/widgets',
            },
        ),
        createRepository: jest.fn().mockResolvedValue({
            owner: 'member',
            name: 'widgets',
            fullName: 'member/widgets',
            defaultBranch: 'master',
            url: 'https://github.com/member/widgets',
        }),
        createRepositoryCopy: jest.fn(),
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

    const deployFacade = {
        getAvailableProvidersForUser: jest
            .fn()
            .mockResolvedValue(input.providers ?? [{ id: 'k8s', enabled: true }]),
    };

    const workRepository: Record<string, jest.Mock> = {
        existsByUserAndSlug: jest.fn().mockResolvedValue(input.slugTaken === true),
        findByOwnerAndSlug: jest.fn().mockResolvedValue(input.slugHolder ?? null),
        findAppWorksByDataRepository: jest.fn().mockResolvedValue(input.ownAppWorks ?? []),
        withTransaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => {
            if (input.transactionError) {
                // The transaction itself is what failed: callers must not receive a
                // half-written pair, and nothing is committed.
                await fn(MANAGER);
                throw input.transactionError;
            }
            return fn(MANAGER);
        }),
        create: jest.fn().mockResolvedValue(createdWork),
    };

    const workUpstreamStates: Record<string, jest.Mock> = {
        create: jest.fn().mockResolvedValue({ id: 'state-1' }),
        update: jest.fn().mockResolvedValue(true),
        findByWorkId: jest.fn().mockResolvedValue(null),
    };

    const eventEmitter = { emitAsync: jest.fn().mockResolvedValue(undefined) };

    const dispatcher = {
        dispatch: input.dispatcherExplodes
            ? jest.fn().mockRejectedValue(new Error('no job runtime'))
            : jest
                  .fn()
                  .mockResolvedValue(
                      input.dispatcherResult === undefined ? 'run-1' : input.dispatcherResult,
                  ),
    };

    const catalog =
        input.catalog === false
            ? undefined
            : {
                  matchBlueprint: jest.fn().mockResolvedValue(null),
                  classifyLicense: jest.fn().mockResolvedValue('green' as const),
              };

    const tierPolicy =
        input.tierOpen === undefined ? undefined : { isOpen: () => input.tierOpen === true };

    const registry = {
        getEnabledPluginsScoped: jest.fn().mockResolvedValue(
            input.appsTierPluginId
                ? [
                      {
                          state: 'loaded',
                          manifest: { capabilities: ['deployment', 'apps-tier'] },
                          plugin: {
                              id: input.appsTierPluginId,
                              capabilities: ['deployment', 'apps-tier'],
                              supportsApps: true,
                              deployApp: () => undefined,
                          },
                      },
                  ]
                : [],
        ),
    };

    const promptedValues =
        input.promptedValues === false
            ? undefined
            : { storePrompted: jest.fn().mockResolvedValue(undefined) };

    const service = new AppWorkCreateService(
        inspector as never,
        locks as never,
        gitFacade as never,
        deployFacade as never,
        workRepository as never,
        workUpstreamStates as never,
        eventEmitter as never,
        dispatcher as never,
        catalog as never,
        tierPolicy as never,
        promptedValues as never,
        registry as never,
    );

    const writes = () => [
        ...Object.entries(gitFacade)
            .filter(([name]) =>
                [
                    'forkRepository',
                    'createRepository',
                    'createRepositoryCopy',
                    'updateRepository',
                    'deleteRepository',
                    'transferRepository',
                    'commit',
                    'push',
                    'createPullRequest',
                    'mergePullRequest',
                    'setActionsPermissions',
                    'createWebhook',
                    'deleteWebhook',
                    'createBranch',
                    'updateBranchRef',
                    'removeLocalDir',
                ].includes(name),
            )
            .map(([name, spy]) => ({ name, calls: spy.mock.calls.length })),
        {
            name: 'workRepository.withTransaction',
            calls: workRepository.withTransaction.mock.calls.length,
        },
        { name: 'workRepository.create', calls: workRepository.create.mock.calls.length },
        { name: 'workUpstreamStates.create', calls: workUpstreamStates.create.mock.calls.length },
        { name: 'workUpstreamStates.update', calls: workUpstreamStates.update.mock.calls.length },
    ];

    return {
        service,
        inspector,
        locks,
        gitFacade,
        deployFacade,
        workRepository,
        workUpstreamStates,
        eventEmitter,
        dispatcher,
        catalog: catalog as never,
        promptedValues: promptedValues as never,
        registry,
        writes,
    };
}

/** Nothing was written, anywhere. */
function expectNoWrites(h: Harness): void {
    for (const entry of h.writes()) {
        expect(entry).toEqual({ name: entry.name, calls: 0 });
    }
    expect(h.eventEmitter.emitAsync).not.toHaveBeenCalled();
    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
}

describe('AppWorkCreateService', () => {
    afterEach(() => {
        delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
    });

    describe('the refusals, each with zero writes (FR-12, ACC-01-07)', () => {
        it('refuses app_works_disabled with 400 when the instance setting is off (R-6)', async () => {
            const h = harness({ appWorksEnabled: false });

            await expect(h.service.create(dto(), USER)).rejects.toMatchObject({
                status: 400,
                response: { status: 'error', code: 'app_works_disabled' },
            });
            expectNoWrites(h);
            expect(h.inspector.inspect).not.toHaveBeenCalled();
        });

        it.each([
            ['invalid_url', 'https://gitlab.com/a/b'],
            ['invalid_url', ''],
        ])('refuses %s before the inspector runs', async (code, url) => {
            const h = harness({});

            await expect(h.service.create(dto({ repositoryUrl: url }), USER)).rejects.toMatchObject(
                {
                    response: { code },
                },
            );
            expectNoWrites(h);
            expect(h.inspector.inspect).not.toHaveBeenCalled();
        });

        it('refuses a missing repositoryMode and a missing targetOwner the way the DTO pipe does', async () => {
            const h = harness({});

            await expect(
                h.service.create(dto({ repositoryMode: undefined }), USER),
            ).rejects.toThrow('repositoryMode must be defined');
            await expect(h.service.create(dto({ targetOwner: undefined }), USER)).rejects.toThrow(
                'targetOwner must be defined',
            );
            await expect(h.service.create(dto({ repositoryMode: 'clone' }), USER)).rejects.toThrow(
                'repositoryMode must be one of link, fork, private-copy',
            );
            expectNoWrites(h);
        });

        it.each([
            'invalid_url',
            'provider_not_connected',
            'not_found',
            'archived',
            'forking_disabled',
            'empty_repository',
            'too_large_for_private_copy',
            'uses_lfs',
        ])(
            'refuses the mode reason %s with zero provider and repository writes',
            async (reason) => {
                const mode =
                    reason === 'forking_disabled' || reason === 'empty_repository'
                        ? 'fork'
                        : 'link';
                const h = harness({
                    inspect: inspectResponse({
                        modes: {
                            link: { available: false, reason },
                            fork: { available: false, reason },
                            'private-copy': { available: false, reason },
                        },
                        defaultMode: null,
                    }),
                });

                await expect(
                    h.service.create(dto({ repositoryMode: mode }), USER),
                ).rejects.toMatchObject({ response: { status: 'error', code: reason } });
                expectNoWrites(h);
            },
        );

        it('refuses in_use_by_another_account with 409 and nothing written', async () => {
            const h = harness({
                inspect: inspectResponse({
                    modes: {
                        link: { available: false, reason: 'in_use_by_another_account' },
                        fork: { available: true },
                        'private-copy': { available: true },
                    },
                }),
            });

            await expect(
                h.service.create(dto({ repositoryMode: 'link', targetOwner: undefined }), USER),
            ).rejects.toMatchObject({
                status: 409,
                response: {
                    code: 'in_use_by_another_account',
                    details: { fullName: 'upstream/widgets' },
                },
            });
            expectNoWrites(h);
        });

        it('refuses rate_limited with 503 and the retry instant, writing nothing', async () => {
            const h = harness({
                inspect: inspectResponse({
                    retryAfter: '2026-09-18T12:00:00.000Z',
                    modes: {
                        link: { available: false, reason: 'rate_limited' },
                        fork: { available: false, reason: 'rate_limited' },
                        'private-copy': { available: false, reason: 'rate_limited' },
                    },
                }),
            });

            await expect(h.service.create(dto(), USER)).rejects.toMatchObject({
                status: 503,
                response: {
                    code: 'rate_limited',
                    details: { retryAfter: '2026-09-18T12:00:00.000Z' },
                },
            });
            expectNoWrites(h);
        });

        it('refuses a requested owner that is not the member’s, writing nothing', async () => {
            const h = harness({
                inspect: inspectResponse({
                    targetOwners: [
                        {
                            login: 'member',
                            type: 'user',
                            available: true,
                            existingForkChecked: true,
                        },
                        {
                            login: 'stranger',
                            type: 'user',
                            available: false,
                            reason: 'target_owner_unavailable',
                            existingForkChecked: false,
                        },
                    ],
                }),
            });

            await expect(
                h.service.create(dto({ targetOwner: 'stranger' }), USER),
            ).rejects.toMatchObject({
                response: { code: 'target_owner_unavailable' },
            });
            expectNoWrites(h);
        });

        it('refuses a taken slug with 409 before the inspector is consulted', async () => {
            const h = harness({ slugTaken: true });

            await expect(h.service.create(dto(), USER)).rejects.toMatchObject({ status: 409 });
            expectNoWrites(h);
            expect(h.inspector.inspect).not.toHaveBeenCalled();
        });

        it('refuses a second concurrent create with 409 create_in_progress', async () => {
            const h = harness({ lockAcquired: false });

            await expect(h.service.create(dto(), USER)).rejects.toMatchObject({
                status: 409,
                response: { code: 'create_in_progress' },
            });
            expectNoWrites(h);
        });

        it('refuses an unknown blueprintId with 400 blueprint_mismatch and zero writes', async () => {
            const h = harness({});
            h.catalog.matchBlueprint.mockResolvedValue(null);

            await expect(
                h.service.create(dto({ blueprintId: 'cal-diy' }), USER),
            ).rejects.toMatchObject({
                status: 400,
                response: { code: 'blueprint_mismatch' },
            });
            expectNoWrites(h);
        });
    });

    describe('idempotency and the own-Work lookup (FR-23, ACC-01-08)', () => {
        it('returns the existing App Work inside the window with alreadyExisted', async () => {
            const h = harness({
                ownAppWorks: [
                    {
                        id: 'work-9',
                        slug: 'widgets',
                        name: 'Widgets',
                        owner: 'member',
                        userId: USER.id,
                        createdAt: new Date(Date.now() - 1_000),
                        sourceRepository: {
                            url: 'https://github.com/member/widgets',
                            owner: 'member',
                            repo: 'widgets',
                            type: 'app_fork',
                            importedAt: new Date(),
                            relatedRepositories: { website: { owner: 'member', repo: 'widgets' } },
                            upstream: { owner: 'upstream', repo: 'widgets', defaultBranch: 'main' },
                            createdByThisWork: false,
                        },
                    },
                ],
            });
            // The adopted fork is what makes the coordinates knowable up front.
            inspectorWithAdoptedFork(h, 'member', 'widgets');

            const result = await h.service.create(dto(), USER);

            expect(result.alreadyExisted).toBe(true);
            expect(result.work.id).toBe('work-9');
            expect(result.appSource.relation).toBe('fork');
            expect(result.appSource.dataRepository).toEqual({
                owner: 'member',
                repo: 'widgets',
                url: 'https://github.com/member/widgets',
            });
            expectNoWrites(h);
        });

        it('refuses 409 app_work_exists when the same repository already has a Work', async () => {
            const h = harness({
                ownAppWorks: [
                    {
                        id: 'work-9',
                        slug: 'other-slug',
                        name: 'Widgets',
                        owner: 'member',
                        userId: USER.id,
                        createdAt: new Date(Date.now() - 5 * 24 * 3_600_000),
                    },
                ],
            });
            inspectorWithAdoptedFork(h, 'member', 'widgets');

            await expect(h.service.create(dto(), USER)).rejects.toMatchObject({
                status: 409,
                response: {
                    code: 'app_work_exists',
                    details: { workId: 'work-9', workName: 'Widgets' },
                },
            });
            expectNoWrites(h);
        });

        it('refuses 409 app_work_exists when the same slug is older than the window', async () => {
            const h = harness({
                ownAppWorks: [
                    {
                        id: 'work-9',
                        slug: 'widgets',
                        name: 'Widgets',
                        owner: 'member',
                        userId: USER.id,
                        createdAt: new Date(Date.now() - APP_CREATE_IDEMPOTENCY_WINDOW_MS - 1),
                    },
                ],
            });
            inspectorWithAdoptedFork(h, 'member', 'widgets');

            await expect(h.service.create(dto(), USER)).rejects.toMatchObject({
                status: 409,
                response: { code: 'app_work_exists' },
            });
            expectNoWrites(h);
        });

        it('refuses 409 when a Work appeared on the coordinates this request just forked', async () => {
            // A NEW fork has no coordinates before step 9, so the one and only
            // lookup for this request is the post-step-9 re-check — and it finds a
            // Work another request created in the meantime.
            const h = harness({
                ownAppWorks: [
                    {
                        id: 'work-raced',
                        slug: 'widgets',
                        name: 'Widgets',
                        owner: 'member',
                        userId: USER.id,
                        createdAt: new Date(),
                    },
                ],
            });

            await expect(h.service.create(dto(), USER)).rejects.toMatchObject({
                status: 409,
                response: { code: 'app_work_exists', details: { workId: 'work-raced' } },
            });
            // The fork itself happened and is never compensated: the next identical
            // request adopts it (FR-25).
            expect(h.gitFacade.forkRepository).toHaveBeenCalledTimes(1);
            expect(h.gitFacade.deleteRepository).not.toHaveBeenCalled();
        });

        /**
         * C9 — the slug check (step 5) must not pre-empt FR-23.
         *
         * A request identical enough to be idempotent ALWAYS carries the slug the
         * first request already took, so a step-5 refusal of every taken slug made
         * `alreadyExisted` unreachable. The harness used to model the taken slug
         * as a flag independent of `ownAppWorks`, which is why the cases above
         * stayed green while the real path answered 409; these cases set both,
         * the way one row sets both on a real database.
         */
        describe('a taken slug and the idempotent answer (C9, FR-23)', () => {
            function freshOwnAppWork(overrides: Record<string, unknown> = {}) {
                return {
                    id: 'work-9',
                    slug: 'widgets',
                    name: 'Widgets',
                    owner: 'member',
                    userId: USER.id,
                    kind: 'app',
                    createdAt: new Date(Date.now() - 1_000),
                    sourceRepository: {
                        url: 'https://github.com/member/widgets',
                        owner: 'member',
                        repo: 'widgets',
                        type: 'app_fork',
                        importedAt: new Date(),
                        relatedRepositories: { website: { owner: 'member', repo: 'widgets' } },
                        upstream: { owner: 'upstream', repo: 'widgets', defaultBranch: 'main' },
                        createdByThisWork: true,
                    },
                    ...overrides,
                };
            }

            const SLUG_MESSAGE =
                'A Work with the slug "widgets" already exists. Choose another slug.';

            it('answers an identical fork create with alreadyExisted even though its slug is taken', async () => {
                const holder = freshOwnAppWork();
                const h = harness({ slugTaken: true, slugHolder: holder, ownAppWorks: [holder] });
                // The first request's fork now exists, so this request adopts it and
                // the equivalent Work is known before any provider write.
                inspectorWithAdoptedFork(h, 'member', 'widgets');

                const result = await h.service.create(dto(), USER);

                expect(result.alreadyExisted).toBe(true);
                expect(result.work.id).toBe('work-9');
                expect(result.appSource.relation).toBe('fork');
                expect(h.workRepository.findByOwnerAndSlug).toHaveBeenCalledWith({
                    userId: USER.id,
                    owner: '',
                    slug: 'widgets',
                });
                expectNoWrites(h);
                expect(h.gitFacade.forkRepository).not.toHaveBeenCalled();
            });

            it('answers an identical link create with alreadyExisted even though its slug is taken', async () => {
                const holder = freshOwnAppWork({
                    sourceRepository: {
                        url: UPSTREAM_URL,
                        owner: 'upstream',
                        repo: 'widgets',
                        type: 'app_link',
                        importedAt: new Date(),
                        relatedRepositories: { website: { owner: 'upstream', repo: 'widgets' } },
                        createdByThisWork: false,
                    },
                });
                const h = harness({
                    slugTaken: true,
                    slugHolder: holder,
                    ownAppWorks: [holder],
                    inspect: inspectResponse({
                        modes: {
                            link: { available: true },
                            fork: { available: true },
                            'private-copy': { available: true },
                        },
                        access: { canPush: true, canAdmin: true },
                    }),
                });

                const result = await h.service.create(
                    dto({ repositoryMode: 'link', targetOwner: undefined }),
                    USER,
                );

                expect(result.alreadyExisted).toBe(true);
                expect(result.work.id).toBe('work-9');
                expect(result.appSource.relation).toBe('link');
                expectNoWrites(h);
            });

            it.each([
                ['a new fork', { repositoryMode: 'fork' }],
                ['a private copy', { repositoryMode: 'private-copy' }],
                ['a link', { repositoryMode: 'link', targetOwner: undefined }],
            ])(
                'refuses %s with the slug 409 and zero writes when the fresh own App Work is on another repository',
                async (_label, overrides) => {
                    const h = harness({
                        slugTaken: true,
                        slugHolder: freshOwnAppWork(),
                        // No App Work on THIS request's repository: nothing FR-23 can
                        // return, so the deferred slug refusal is the answer.
                        ownAppWorks: [],
                        inspect: inspectResponse({
                            modes: {
                                link: { available: true },
                                fork: { available: true },
                                'private-copy': { available: true },
                            },
                        }),
                    });

                    const attempt = h.service.create(dto(overrides), USER);

                    await expect(attempt).rejects.toMatchObject({ status: 409 });
                    await expect(attempt).rejects.toThrow(SLUG_MESSAGE);
                    // Deferred, not skipped: the inspector ran, and the refusal still
                    // came before the provider write.
                    expect(h.inspector.inspect).toHaveBeenCalledTimes(1);
                    expect(h.gitFacade.forkRepository).not.toHaveBeenCalled();
                    expect(h.gitFacade.createRepository).not.toHaveBeenCalled();
                    expectNoWrites(h);
                },
            );

            it.each([
                ['a Repository Work', freshOwnAppWork({ kind: 'repo' })],
                ['a Work with no kind', freshOwnAppWork({ kind: undefined })],
                [
                    'an App Work older than the window',
                    freshOwnAppWork({
                        createdAt: new Date(Date.now() - APP_CREATE_IDEMPOTENCY_WINDOW_MS - 1),
                    }),
                ],
                ['an App Work with no createdAt', freshOwnAppWork({ createdAt: undefined })],
            ])(
                'refuses a slug held by %s with 409 before the inspector is consulted',
                async (_label, holder) => {
                    const h = harness({
                        slugTaken: true,
                        slugHolder: holder,
                        ownAppWorks: [holder],
                    });
                    inspectorWithAdoptedFork(h, 'member', 'widgets');

                    const attempt = h.service.create(dto(), USER);

                    await expect(attempt).rejects.toMatchObject({ status: 409 });
                    await expect(attempt).rejects.toThrow(SLUG_MESSAGE);
                    expect(h.inspector.inspect).not.toHaveBeenCalled();
                    expect(h.locks.runExclusive).not.toHaveBeenCalled();
                    expectNoWrites(h);
                },
            );
        });
    });

    describe('the three relations (FR-25, ACC-01-02, ACC-01-04, ACC-01-05)', () => {
        it('links with no provider write at all (ACC-01-01)', async () => {
            const h = harness({
                inspect: inspectResponse({
                    modes: {
                        link: { available: true },
                        fork: { available: true },
                        'private-copy': { available: true },
                    },
                    access: { canPush: true, canAdmin: true },
                }),
            });

            const result = await h.service.create(
                dto({ repositoryMode: 'link', targetOwner: undefined }),
                USER,
            );

            expect(h.gitFacade.forkRepository).not.toHaveBeenCalled();
            expect(h.gitFacade.createRepository).not.toHaveBeenCalled();
            expect(result.appSource.relation).toBe('link');
            expect(result.appSource.upstream).toBeUndefined();
            expect(result.appSource.dataRepository.owner).toBe('upstream');
        });

        it('adopts an existing fork with no fork call and createdByThisWork: false (ACC-01-04)', async () => {
            const h = harness({});
            inspectorWithAdoptedFork(h, 'member', 'widgets-renamed');

            const result = await h.service.create(dto(), USER);

            expect(h.gitFacade.forkRepository).not.toHaveBeenCalled();
            const [workData, , manager] = h.workRepository.create.mock.calls[0];
            expect(workData.sourceRepository.createdByThisWork).toBe(false);
            expect(workData.sourceRepository.type).toBe('app_fork');
            expect(workData.sourceRepository.relatedRepositories.website).toEqual({
                owner: 'member',
                repo: 'widgets-renamed',
            });
            expect(workData.sourceRepository.upstream).toEqual({
                owner: 'upstream',
                repo: 'widgets',
                defaultBranch: 'main',
            });
            expect(manager).toBe(MANAGER);
            expect(result.appSource.relation).toBe('fork');
        });

        it('forks when no fork exists and records createdByThisWork: true (ACC-01-02)', async () => {
            const h = harness({});

            const result = await h.service.create(dto(), USER);

            expect(h.gitFacade.forkRepository).toHaveBeenCalledTimes(1);
            const [owner, repo, options, gitOptions] = h.gitFacade.forkRepository.mock.calls[0];
            expect([owner, repo]).toEqual(['upstream', 'widgets']);
            expect(options).toMatchObject({ waitForReady: false });
            expect(gitOptions).toMatchObject({ userId: USER.id, providerId: 'github' });
            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.sourceRepository.createdByThisWork).toBe(true);
            expect(result.appSource.upstream).toEqual({
                owner: 'upstream',
                repo: 'widgets',
                defaultBranch: 'main',
            });
        });

        it('forks into an organization with the member’s own connection (ACC-01-03)', async () => {
            const h = harness({ providers: [] });
            h.inspector.inspect.mockResolvedValue(
                inspectResponse({
                    targetOwners: [
                        {
                            login: 'member',
                            type: 'user',
                            available: true,
                            existingForkChecked: true,
                        },
                        {
                            login: 'acme',
                            type: 'organization',
                            available: true,
                            existingForkChecked: true,
                        },
                    ],
                }),
            );

            await h.service.create(dto({ targetOwner: 'acme' }), USER);

            const [, , options, gitOptions] = h.gitFacade.forkRepository.mock.calls[0];
            expect(options).toMatchObject({ organization: 'acme', waitForReady: false });
            // The member's connection, never a platform one.
            expect(gitOptions).toMatchObject({ userId: USER.id, providerId: 'github' });
            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.organization).toBe(true);
            expect(workData.owner).toBe('member');
        });

        it('creates a private shell with the name ladder and never a public repository (ACC-01-05)', async () => {
            const h = harness({});
            // Every name up to `-copy-4` is taken by a NON-empty repository, so the
            // ladder must run to its documented end.
            h.gitFacade.getRepository
                .mockResolvedValueOnce({
                    owner: 'member',
                    name: 'widgets',
                    empty: false,
                    defaultBranch: 'master',
                })
                .mockResolvedValueOnce({
                    owner: 'member',
                    name: 'widgets-copy-2',
                    empty: false,
                    defaultBranch: 'master',
                })
                .mockResolvedValueOnce({
                    owner: 'member',
                    name: 'widgets-copy-3',
                    empty: false,
                    defaultBranch: 'master',
                })
                .mockResolvedValueOnce({
                    owner: 'member',
                    name: 'widgets-copy-4',
                    empty: false,
                    defaultBranch: 'master',
                })
                .mockResolvedValue(null);
            h.gitFacade.createRepository.mockResolvedValue({
                owner: 'member',
                name: 'widgets-copy-5',
                fullName: 'member/widgets-copy-5',
                defaultBranch: 'master',
                url: 'https://github.com/member/widgets-copy-5',
            });

            const result = await h.service.create(dto({ repositoryMode: 'private-copy' }), USER);

            expect(h.gitFacade.createRepository).toHaveBeenCalledTimes(1);
            expect(h.gitFacade.createRepository).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'widgets-copy-5', isPrivate: true }),
                expect.objectContaining({ userId: USER.id }),
            );
            expect(result.appSource.dataRepository.repo).toBe('widgets-copy-5');
            expect(result.appSource.relation).toBe('private-copy');
        });

        it('refuses copy_name_unavailable when every candidate name is taken, writing nothing', async () => {
            const h = harness({});
            h.gitFacade.getRepository.mockResolvedValue({
                owner: 'member',
                name: 'widgets',
                empty: false,
                defaultBranch: 'master',
            });

            await expect(
                h.service.create(dto({ repositoryMode: 'private-copy' }), USER),
            ).rejects.toMatchObject({ status: 409, response: { code: 'copy_name_unavailable' } });
            expectNoWrites(h);
        });

        it('adopts an existing EMPTY private shell instead of creating one', async () => {
            const h = harness({
                existingRepository: {
                    owner: 'member',
                    name: 'widgets',
                    empty: true,
                    defaultBranch: 'master',
                },
            });

            const result = await h.service.create(dto({ repositoryMode: 'private-copy' }), USER);

            expect(h.gitFacade.createRepository).not.toHaveBeenCalled();
            expect(result.appSource.dataRepository.repo).toBe('widgets');
        });
    });

    describe('one transaction, two rows (plan §4.2 step 10)', () => {
        it('writes the Work and its state row through the SAME manager', async () => {
            const h = harness({});

            await h.service.create(dto(), USER);

            expect(h.workRepository.withTransaction).toHaveBeenCalledTimes(1);
            expect(h.workRepository.create.mock.calls[0][2]).toBe(MANAGER);
            expect(h.workUpstreamStates.create.mock.calls[0][1]).toBe(MANAGER);
        });

        it('rolls both rows back and leaves the fork when the transaction throws', async () => {
            const h = harness({ transactionError: new Error('deadlock') });

            await expect(h.service.create(dto(), USER)).rejects.toBeTruthy();

            // Both creates ran inside the transaction, so a throw rolls both back…
            expect(h.workRepository.create).toHaveBeenCalledTimes(1);
            expect(h.workUpstreamStates.create).toHaveBeenCalledTimes(1);
            // …nothing is dispatched and nothing is emitted…
            expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
            expect(h.eventEmitter.emitAsync).not.toHaveBeenCalled();
            // …and the fork stays: there is no compensating delete (FR-25).
            expect(h.gitFacade.forkRepository).toHaveBeenCalledTimes(1);
            expect(h.gitFacade.deleteRepository).not.toHaveBeenCalled();
        });

        it('writes the per-relation state row for a LINK (plan §4.2 step 10)', async () => {
            const h = harness({
                inspect: inspectResponse({
                    modes: {
                        link: { available: true },
                        fork: { available: true },
                        'private-copy': { available: true },
                    },
                }),
            });

            await h.service.create(dto({ repositoryMode: 'link', targetOwner: undefined }), USER);

            const [row] = h.workUpstreamStates.create.mock.calls[0];
            expect(row).toMatchObject({
                workId: 'work-1',
                relation: 'link',
                dataOwner: 'upstream',
                dataRepo: 'widgets',
                dataDefaultBranch: 'main',
                upstreamOwner: null,
                upstreamRepo: null,
                upstreamDefaultBranch: null,
                upstreamStatus: 'none',
                actionsState: 'not_applicable',
                nextSyncAt: null,
            });
        });

        it('writes the per-relation state row for a FORK', async () => {
            const h = harness({});

            await h.service.create(dto(), USER);

            const [row] = h.workUpstreamStates.create.mock.calls[0];
            expect(row).toMatchObject({
                relation: 'fork',
                dataOwner: 'member',
                dataRepo: 'widgets',
                dataDefaultBranch: 'main',
                upstreamOwner: 'upstream',
                upstreamRepo: 'widgets',
                upstreamDefaultBranch: 'main',
                upstreamStatus: 'unknown',
                actionsState: 'pending',
                nextSyncAt: null,
            });
            expect(row.readinessStartedAt).toBeInstanceOf(Date);
        });

        it('tracks the UPSTREAM branch for a private copy, never the empty shell’s (plan §4.2 step 10)', async () => {
            const h = harness({});
            h.gitFacade.getRepository.mockResolvedValue(null);
            h.gitFacade.createRepository.mockResolvedValue({
                owner: 'member',
                name: 'widgets',
                defaultBranch: 'master',
                url: 'https://github.com/member/widgets',
            });

            await h.service.create(dto({ repositoryMode: 'private-copy' }), USER);

            const [row] = h.workUpstreamStates.create.mock.calls[0];
            expect(row.dataDefaultBranch).toBe('main');
            expect(row.upstreamDefaultBranch).toBe('main');
            expect(row.upstreamStatus).toBe('unknown');
            expect(row.actionsState).toBe('pending');
        });
    });

    describe('the readiness dispatch (plan §4.2 step 11, APW-02’s payload)', () => {
        it('dispatches once, after the commit, with the four payload fields and no relation', async () => {
            const h = harness({});

            await h.service.create(dto(), USER);

            expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(1);
            expect(h.dispatcher.dispatch).toHaveBeenCalledWith({
                workId: 'work-1',
                attempt: 1,
                reason: 'initial',
                providerId: 'github',
                credentialVersion: undefined,
            });
            // The payload is written by APW-02's dispatcher type: `relation` is not
            // one of its fields (it lives on the state row).
            expect(Object.keys(h.dispatcher.dispatch.mock.calls[0][0])).toEqual([
                'workId',
                'attempt',
                'reason',
                'providerId',
                'credentialVersion',
            ]);
            // Dispatched AFTER the transaction committed.
            expect(h.workUpstreamStates.create.mock.invocationCallOrder[0]).toBeLessThan(
                h.dispatcher.dispatch.mock.invocationCallOrder[0],
            );
        });

        it('records dispatch_unavailable on the state row when nothing was queued', async () => {
            const h = harness({ dispatcherResult: null });

            await h.service.create(dto(), USER);

            expect(h.workUpstreamStates.update).toHaveBeenCalledWith('work-1', {
                readinessReason: 'dispatch_unavailable',
            });
        });

        it('records dispatch_unavailable when the dispatcher throws', async () => {
            const h = harness({ dispatcherExplodes: true });

            const result = await h.service.create(dto(), USER);

            expect(result.work.id).toBe('work-1');
            expect(h.workUpstreamStates.update).toHaveBeenCalledWith('work-1', {
                readinessReason: 'dispatch_unavailable',
            });
        });

        it('stamps the values captured BEFORE the transaction, not re-read after it', async () => {
            const h = harness({});
            const order: string[] = [];
            h.workRepository.withTransaction.mockImplementation(
                async (fn: (manager: unknown) => Promise<unknown>) => {
                    order.push('transaction');
                    return fn(MANAGER);
                },
            );
            h.dispatcher.dispatch.mockImplementation(async (payload: { providerId: string }) => {
                order.push('dispatch');
                return `run-${payload.providerId}`;
            });

            await h.service.create(dto(), USER);

            expect(order).toEqual(['transaction', 'dispatch']);
            expect(h.dispatcher.dispatch.mock.calls[0][0].providerId).toBe('github');
        });
    });

    describe('the deploy target (FR-33, FR-34, ACC-01-12, R-5)', () => {
        it('persists nothing for None and reports it', async () => {
            const h = harness({});

            const result = await h.service.create(dto({ deployProvider: undefined }), USER);

            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.deployProvider).toBeNull();
            expect(result.appSource.deployTarget).toBe('none');
            // Onboarding defaults are never applied: the facade is not even asked.
            expect(h.deployFacade.getAvailableProvidersForUser).not.toHaveBeenCalled();
        });

        it('persists your-cluster’s own plugin id', async () => {
            const h = harness({ providers: [{ id: 'k8s', enabled: true }] });

            const result = await h.service.create(dto({ deployProvider: 'k8s' }), USER);

            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.deployProvider).toBe('k8s');
            expect(result.appSource.deployTarget).toBe('your-cluster');
        });

        it('refuses cluster_target_unavailable for a provider the member cannot use', async () => {
            const h = harness({ providers: [{ id: 'vercel', enabled: false }] });

            await expect(
                h.service.create(dto({ deployProvider: 'k8s' }), USER),
            ).rejects.toMatchObject({
                status: 400,
                response: { code: 'cluster_target_unavailable' },
            });
            expectNoWrites(h);
        });

        it('refuses the ever-works alias while the tier policy is unbound (ACC-01-12)', async () => {
            const h = harness({});

            await expect(
                h.service.create(dto({ deployProvider: 'ever-works' }), USER),
            ).rejects.toMatchObject({
                status: 400,
                response: { code: 'managed_hosting_unavailable' },
            });
            expectNoWrites(h);
        });

        it('refuses the alias while the tier policy is bound and closed (R-5)', async () => {
            const h = harness({ tierOpen: false });

            await expect(
                h.service.create(dto({ deployProvider: 'ever-works' }), USER),
            ).rejects.toMatchObject({ response: { code: 'managed_hosting_unavailable' } });
            expectNoWrites(h);
        });

        it('persists the apps-tier plugin id — never the literal ever-works — while the tier is open', async () => {
            const h = harness({
                tierOpen: true,
                appsTierPluginId: 'apps-tier',
                inspect: inspectResponse({
                    deployTargets: {
                        none: { available: true },
                        'your-cluster': { available: true, providerId: 'k8s' },
                        'ever-works-apps': { available: true, providerId: 'apps-tier' },
                    },
                }),
            });

            const result = await h.service.create(dto({ deployProvider: 'ever-works' }), USER);

            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.deployProvider).toBe('apps-tier');
            expect(workData.deployProvider).not.toBe('ever-works');
            expect(result.appSource.deployTarget).toBe('ever-works-apps');
        });

        it('routes an explicitly requested apps-tier plugin id to the managed target', async () => {
            const h = harness({
                tierOpen: true,
                appsTierPluginId: 'apps-tier',
                inspect: inspectResponse({
                    deployTargets: {
                        none: { available: true },
                        'your-cluster': { available: true, providerId: 'k8s' },
                        'ever-works-apps': { available: true, providerId: 'apps-tier' },
                    },
                }),
            });

            const result = await h.service.create(dto({ deployProvider: 'apps-tier' }), USER);

            expect(h.workRepository.create.mock.calls[0][0].deployProvider).toBe('apps-tier');
            expect(result.appSource.deployTarget).toBe('ever-works-apps');
        });

        it('refuses an apps-tier plugin id while the tier is closed', async () => {
            const h = harness({ tierOpen: false, appsTierPluginId: 'apps-tier' });

            await expect(
                h.service.create(dto({ deployProvider: 'apps-tier' }), USER),
            ).rejects.toMatchObject({ response: { code: 'managed_hosting_unavailable' } });
            expectNoWrites(h);
        });
    });

    describe('the Blueprint matrix (FR-29b, ACC-01-21)', () => {
        it('persists the catalog’s own match when no id was sent', async () => {
            const h = harness({
                inspect: inspectResponse({
                    blueprint: {
                        status: 'matched',
                        id: 'cal-diy',
                        version: '1.0.0',
                        name: 'Cal.diy',
                        matchSource: 'manifest',
                    },
                }),
            });

            const result = await h.service.create(dto(), USER);

            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.sourceRepository.blueprintId).toBe('cal-diy');
            expect(workData.sourceRepository.blueprintMatchSource).toBe('manifest');
            expect(result.appSource.blueprint).toMatchObject({
                id: 'cal-diy',
                matchSource: 'manifest',
            });
        });

        it.each([
            ['none', { status: 'none' }],
            ['unavailable', { status: 'unavailable' }],
        ])('creates without a Blueprint when the match is %s', async (_label, blueprint) => {
            const h = harness({ inspect: inspectResponse({ blueprint }) });

            const result = await h.service.create(dto(), USER);

            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.sourceRepository.blueprintId).toBeUndefined();
            expect(workData.sourceRepository.blueprintMatchSource).toBeUndefined();
            expect(result.appSource.blueprint).toBeUndefined();
        });

        it('creates without a Blueprint when the catalog port is unbound', async () => {
            const h = harness({
                catalog: false,
                inspect: inspectResponse({ blueprint: { status: 'unavailable' } }),
            });

            const result = await h.service.create(dto(), USER);

            expect(result.status).toBe('success');
            expect(
                h.workRepository.create.mock.calls[0][0].sourceRepository.blueprintId,
            ).toBeUndefined();
        });

        it('keeps the match’s own source when the sent id equals it', async () => {
            const h = harness({
                inspect: inspectResponse({
                    blueprint: { status: 'matched', id: 'cal-diy', matchSource: 'fork' },
                }),
            });

            await h.service.create(dto({ blueprintId: 'cal-diy' }), USER);

            expect(h.catalog.matchBlueprint).not.toHaveBeenCalled();
            expect(
                h.workRepository.create.mock.calls[0][0].sourceRepository.blueprintMatchSource,
            ).toBe('fork');
        });

        it('asks for the id the caller named and records it as explicit', async () => {
            const h = harness({});
            h.catalog.matchBlueprint.mockResolvedValue({
                id: 'umami',
                version: '2.0.0',
                verified: true,
                name: 'umami',
                matchSource: 'probe',
            });

            await h.service.create(dto({ blueprintId: 'umami' }), USER);

            expect(h.catalog.matchBlueprint).toHaveBeenCalledWith({
                owner: 'upstream',
                repo: 'widgets',
                blueprintId: 'umami',
            });
            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.sourceRepository.blueprintId).toBe('umami');
            expect(workData.sourceRepository.blueprintMatchSource).toBe('explicit');
        });
    });

    describe('autoProvision (ACC-01-28, plan §3.1)', () => {
        it('persists autoProvision: false when the member declined', async () => {
            const h = harness({});

            await h.service.create(dto({ autoProvision: false }), USER);

            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.sourceRepository.autoProvision).toBe(false);
        });

        it.each([[undefined], [true]])(
            'leaves autoProvision ABSENT when the field is %s',
            async (value) => {
                const h = harness({});

                await h.service.create(dto({ autoProvision: value }), USER);

                const [workData] = h.workRepository.create.mock.calls[0];
                expect('autoProvision' in workData.sourceRepository).toBe(false);
            },
        );

        it('creates a LINK with no targetOwner at all', async () => {
            const h = harness({
                inspect: inspectResponse({
                    modes: {
                        link: { available: true },
                        fork: { available: true },
                        'private-copy': { available: true },
                    },
                }),
            });

            const result = await h.service.create(
                dto({ repositoryMode: 'link', targetOwner: undefined }),
                USER,
            );

            expect(result.status).toBe('success');
            expect(result.appSource.relation).toBe('link');
        });
    });

    describe('prompted values (FR-55, ACC-01-22)', () => {
        it('succeeds with the port unbound and drops the values without refusing', async () => {
            const h = harness({ promptedValues: false });

            const result = await h.service.create(
                dto({ appEnv: { admin_email: 'ops@example.com' } }),
                USER,
            );

            expect(result.status).toBe('success');
        });

        it('hands every name to storePrompted exactly once when the port is bound', async () => {
            const h = harness({});

            await h.service.create(
                dto({ appEnv: { admin_email: 'ops@example.com', admin_password: 'secret' } }),
                USER,
            );

            expect(h.promptedValues.storePrompted).toHaveBeenCalledTimes(1);
            expect(h.promptedValues.storePrompted).toHaveBeenCalledWith('work-1', {
                admin_email: 'ops@example.com',
                admin_password: 'secret',
            });
        });

        it('never echoes a value in the response', async () => {
            const h = harness({});

            const result = await h.service.create(
                dto({ appEnv: { admin_password: 'secret' } }),
                USER,
            );

            expect(JSON.stringify(result)).not.toContain('secret');
        });
    });

    describe('a renamed fork the scan did not reach (ACC-01-26, FR-19)', () => {
        it('is still adopted at create with NO fork request', async () => {
            const h = harness({});
            // The scan reported the owner as available but NOT checked — the 15-call
            // budget did not reach it — so the inspection carries no `existingFork`
            // and the create path has to ask the question itself.
            h.inspector.inspect.mockResolvedValue(
                inspectResponse({
                    scanIncomplete: true,
                    targetOwners: [
                        {
                            login: 'member',
                            type: 'user',
                            available: true,
                            existingForkChecked: false,
                        },
                    ],
                }),
            );
            h.gitFacade.findExistingFork.mockResolvedValue({
                owner: 'member',
                name: 'widgets-renamed',
                fullName: 'member/widgets-renamed',
                url: 'https://github.com/member/widgets-renamed',
                defaultBranch: 'main',
            });

            const result = await h.service.create(dto(), USER);

            expect(h.gitFacade.findExistingFork).toHaveBeenCalledWith(
                'upstream',
                'widgets',
                'member',
                expect.objectContaining({ userId: USER.id }),
            );
            // No second fork for an account that already holds one.
            expect(h.gitFacade.forkRepository).not.toHaveBeenCalled();
            const [workData] = h.workRepository.create.mock.calls[0];
            expect(workData.sourceRepository.createdByThisWork).toBe(false);
            expect(workData.sourceRepository.relatedRepositories.website).toEqual({
                owner: 'member',
                repo: 'widgets-renamed',
            });
            const [row] = h.workUpstreamStates.create.mock.calls[0];
            expect(row).toMatchObject({ dataOwner: 'member', dataRepo: 'widgets-renamed' });
            expect(result.status).toBe('success');
        });

        it('forks once when the unlooked-for owner really has no fork', async () => {
            const h = harness({});
            h.inspector.inspect.mockResolvedValue(
                inspectResponse({
                    scanIncomplete: true,
                    targetOwners: [
                        {
                            login: 'member',
                            type: 'user',
                            available: true,
                            existingForkChecked: false,
                        },
                    ],
                }),
            );
            h.gitFacade.findExistingFork.mockResolvedValue(null);

            await h.service.create(dto(), USER);

            expect(h.gitFacade.findExistingFork).toHaveBeenCalledTimes(1);
            expect(h.gitFacade.forkRepository).toHaveBeenCalledTimes(1);
        });

        it('does NOT re-ask when the scan already checked the owner', async () => {
            const h = harness({});

            await h.service.create(dto(), USER);

            expect(h.gitFacade.findExistingFork).not.toHaveBeenCalled();
            expect(h.gitFacade.forkRepository).toHaveBeenCalledTimes(1);
        });

        it('adopts the fork the inspection DID find, with no fork request at all', async () => {
            const h = harness({});
            inspectorWithAdoptedFork(h, 'member', 'widgets-renamed');

            await h.service.create(dto(), USER);

            expect(h.gitFacade.forkRepository).not.toHaveBeenCalled();
            expect(h.gitFacade.findExistingFork).not.toHaveBeenCalled();
        });
    });

    describe('the create event (plan §4.2 step 12)', () => {
        it('emits work.created after the transaction', async () => {
            const h = harness({});

            await h.service.create(dto(), USER);

            expect(h.eventEmitter.emitAsync).toHaveBeenCalledTimes(1);
            expect(h.eventEmitter.emitAsync.mock.calls[0][0]).toBe('work.created');
            expect(h.workUpstreamStates.create.mock.invocationCallOrder[0]).toBeLessThan(
                h.eventEmitter.emitAsync.mock.invocationCallOrder[0],
            );
        });
    });
});

/** Point the canned inspection at an existing fork, as the scan would report it. */
function inspectorWithAdoptedFork(h: Harness, owner: string, repo: string): void {
    h.inspector.inspect.mockResolvedValue(
        inspectResponse({
            targetOwners: [
                {
                    login: 'member',
                    type: 'user',
                    available: true,
                    existingForkChecked: true,
                    existingFork: {
                        owner,
                        repo,
                        fullName: `${owner}/${repo}`,
                        url: `https://github.com/${owner}/${repo}`,
                        inUseByAnotherAccount: false,
                    },
                },
                { login: 'acme', type: 'organization', available: true, existingForkChecked: true },
            ],
        }),
    );
}
