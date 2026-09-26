import type { Repository } from 'typeorm';
import {
    APP_BUILD_WORKFLOW_PATH,
    computeBuildInputsHash,
    type AppSpec,
} from '@ever-works/contracts';
import type { BuildRepositoryRef, BuildValue, PrepareRepositoryResult } from '@ever-works/plugin';
import type { AppEnvResolver } from '../../app-env/app-env.resolver';
import { DistributedTaskLockService } from '../../cache/distributed-task-lock.service';
import type { WorkBuildPreparationPatch } from '../../database/repositories/app-build-preparation.repository';
import { WorkBuild } from '../../entities/work-build.entity';
import { WorkBuildPreparation } from '../../entities/work-build-preparation.entity';
import type {
    AppBuildSpecRead,
    AppBuildWorkContext,
    AppBuildsService,
} from '../app-builds.service';
import {
    APP_BUILD_PREPARE_JOB_ID,
    APP_BUILD_PREPARE_LEASE_MARGIN_MS,
    APP_BUILD_PREPARE_LOCK_TTL_MS,
    APP_BUILD_PREPARE_MAX_PASSES,
    AppBuildPrepareRunner,
    appBuildPrepareLockKey,
    declaredBuildMemoryGiB,
    mapPluginBlockedReason,
    selectBuildRunner,
    unionMinusRemoved,
    type AppBuildPrepareInput,
    type AppBuildPreparePluginBinding,
} from '../app-build-prepare.runner';

/**
 * APW-05 T19 — the `app-build-prepare` runner (plan §7.2, §7.1, §4.6, §4.7).
 *
 * Every collaborator is a hand-built fake and the Builds live in an in-memory
 * table, because the properties under test are WHICH repository call happened,
 * in WHAT order, with WHAT arguments — a real DataSource would test TypeORM.
 *
 * The three seams that make the table honest:
 *
 * - `rows` mimics the conditional `UPDATE … WHERE id = :id AND status IN (…)`
 *   claims the runner issues through `createQueryBuilder`, and APPLIES the patch
 *   to the stored row, so "the Build is blocked" and "the blocked reason was
 *   cleared" are assertions about the row rather than about a mock's arguments.
 *   The claims ARE the exactly-once mechanism, so a fake that ignored them would
 *   let the retry cases pass for the wrong reason.
 * - `builds` implements the one `AppBuildRepository` member the runner reads
 *   (`findPage`) with the repository's own order (`createdAt DESC`), so
 *   "newest first" in step 7 is exercised rather than assumed.
 * - `plugin`, `env`, `specs`, `works` and `locks` record what the runner asked
 *   for, so "no plugin call" and "nothing is dispatched" are assertions.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const TRACKED = 'main';
const FULL_NAME = 'acme/shop';
const PLUGIN_ID = 'github-actions-build';
const CONTENT_SHA = 'c'.repeat(64);
const INPUTS_HASH = computeBuildInputsHash([{ name: 'DATABASE_URL', fingerprint: 'v3' }]);

/** The App spec a prepare is generated from (plan §7.2 step 1). */
const SPEC: AppSpec = {
    kind: 'app',
    appSpecVersion: 1,
    display: { name: 'Shop' },
    build: {
        strategy: 'dockerfile',
        dockerfile: 'Dockerfile',
        context: '.',
        args: [{ name: 'DATABASE_URL', fromEnv: 'DATABASE_URL' }],
        services: [{ name: 'postgres', image: 'postgres:16' }],
        resources: { cpu: 2, memory: '2Gi', timeoutMinutes: 60 },
    },
    components: [{ name: 'web', role: 'web', port: 3000 }],
    checks: [{ name: 'lint', command: 'npm run lint', required: true, timeoutSeconds: 900 }],
} as AppSpec;

/** The same spec with no `build` block — what a `none`/`image` Work looks like. */
const NO_BUILD_SPEC: AppSpec = {
    kind: 'app',
    appSpecVersion: 1,
    display: { name: 'Docs' },
    build: { strategy: 'none' },
} as AppSpec;

/* -------------------------------------------------------------------------- *
 * In-memory tables
 * -------------------------------------------------------------------------- */

function buildRow(overrides: Partial<WorkBuild> & { number: number }): WorkBuild {
    return {
        id: `build-${overrides.number}`,
        workId: WORK_ID,
        buildPluginId: PLUGIN_ID,
        status: 'queued',
        trigger: 'manual',
        branch: TRACKED,
        commitSha: SHA,
        runAttempt: 1,
        digestConfirmed: false,
        deployable: false,
        syncOrigin: 'none',
        createdAt: new Date(2026, 0, overrides.number),
        updatedAt: new Date(2026, 0, overrides.number),
        ...overrides,
    } as WorkBuild;
}

function preparationRow(overrides: Partial<WorkBuildPreparation> = {}): WorkBuildPreparation {
    return {
        id: 'prep-1',
        workId: WORK_ID,
        buildPluginId: PLUGIN_ID,
        workflowState: 'none',
        webhookState: 'none',
        prepareSeq: 0,
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
        ...overrides,
    } as WorkBuildPreparation;
}

/**
 * One `andWhere` predicate of the runner's conditional updates, EVALUATED against
 * a stored row. Matched by its exact text: a predicate this fake does not model
 * throws, so a claim that gains or changes an arm fails loudly here instead of
 * being answered by a fake that silently ignores it (which is how a claim that
 * lost its `dispatchedAt IS NULL` arm would otherwise stay green).
 */
function claimPredicate(
    sql: string,
    params: Record<string, unknown> = {},
): (row: WorkBuild) => boolean {
    switch (sql) {
        case 'status IN (:...statuses)':
            return (row) => ((params.statuses as string[]) ?? []).includes(row.status);
        case 'status = :status':
            return (row) => row.status === params.status;
        case 'dispatchedAt IS NULL':
            return (row) => row.dispatchedAt == null;
        case 'dispatchedAt = :claimedAt':
            // The column is a bigint epoch-ms `TimestampColumn`, so the claim is
            // released by the NUMBER it was stamped with.
            return (row) =>
                row.dispatchedAt != null &&
                new Date(row.dispatchedAt).getTime() === params.claimedAt;
        case 'providerRunId IS NULL':
            return (row) => row.providerRunId == null;
        default:
            throw new Error(`rowsRepository: unrecognised claim predicate: ${sql}`);
    }
}

/**
 * The entity repository's conditional-update chain, applied to the stored rows.
 *
 * The SQL fragments the runner writes are matched by their own text
 * (`id = :id` / `id IN (:...ids)` / `status IN (:...statuses)` / `status =
 * :status` / `dispatchedAt IS NULL` / `dispatchedAt = :claimedAt` /
 * `providerRunId IS NULL`) and anything else THROWS, so a change to a claim's
 * predicate shows up here as a failing assertion rather than as a silently
 * permissive fake.
 *
 * `hooks.beforeExecute` sees each `SET` before it is applied and may throw — the
 * "database error after the provider call" of the claim cases.
 */
function rowsRepository(
    store: { builds: WorkBuild[] },
    hooks: { beforeExecute?: (fields: Partial<WorkBuild>) => void } = {},
): Repository<WorkBuild> {
    return {
        createQueryBuilder: () => {
            let fields: Partial<WorkBuild> = {};
            let ids: string[] = [];
            const predicates: Array<(row: WorkBuild) => boolean> = [];
            const chain = {
                update: () => chain,
                set: (next: Partial<WorkBuild>) => {
                    fields = next;
                    return chain;
                },
                where: (sql: string, params: Record<string, unknown>) => {
                    if (sql === 'id IN (:...ids)') ids = (params.ids as string[]) ?? [];
                    else if (sql === 'id = :id') ids = [String(params.id)];
                    else throw new Error(`rowsRepository: unrecognised WHERE: ${sql}`);
                    return chain;
                },
                andWhere: (sql: string, params: Record<string, unknown>) => {
                    predicates.push(claimPredicate(sql, params));
                    return chain;
                },
                execute: async () => {
                    hooks.beforeExecute?.(fields);
                    let affected = 0;
                    for (const row of store.builds) {
                        if (!ids.includes(row.id)) continue;
                        if (!predicates.every((holds) => holds(row))) continue;
                        Object.assign(row, fields);
                        affected += 1;
                    }
                    return { affected };
                },
            };
            return chain;
        },
    } as unknown as Repository<WorkBuild>;
}

/* -------------------------------------------------------------------------- *
 * The harness
 * -------------------------------------------------------------------------- */

interface Harness {
    readonly runner: AppBuildPrepareRunner;
    readonly store: { row: WorkBuildPreparation | null; builds: WorkBuild[] };
    readonly binding: AppBuildPreparePluginBinding;
    readonly plugin: {
        prepareRepository: jest.Mock;
        startBuild: jest.Mock;
        setActionsPermissions: jest.Mock;
        getFileContent: jest.Mock;
        resolve: jest.Mock;
    };
    readonly env: { resolveForBuild: jest.Mock };
    readonly specs: { read: jest.Mock };
    readonly works: { read: jest.Mock };
    readonly service: { publish: jest.Mock; dispatchPrepare: jest.Mock; dispatchWatch: jest.Mock };
    readonly upserts: WorkBuildPreparationPatch[];
    /** The `work_builds` fake's hooks — set `beforeExecute` to fail a write. */
    readonly rowsHooks: { beforeExecute?: (fields: Partial<WorkBuild>) => void };
    /** The two repository fakes, for a case that builds its own runner around them. */
    readonly repositories: { builds: unknown; preparations: unknown };
    readonly lock: {
        runExclusive: jest.Mock;
        calls: string[];
        hold: () => void;
        release: () => void;
        /** True while a `runExclusive` holds the key (or `hold()` was called). */
        isHeld: () => boolean;
        /**
         * Runs after `fn` settles and BEFORE the lock is released — the window
         * between the loop's last `prepareSeq` read and the release.
         */
        afterFn?: () => Promise<void>;
    };
    /** Re-point the binding's repository — the `visibility`/`createdByAppWork` axes of R-4 and FR-22. */
    setRepository(patch: Partial<BuildRepositoryRef>): void;
    /** The `prepareRepository` request of the nth call (1-based). */
    prepareCall(index?: number): AppBuildPrepareInput;
    /** The `startBuild` argument of the nth call (1-based). */
    startCall(index?: number): { buildId: string; ref: string; sha: string; mode: string };
}

function prepareResult(overrides: Partial<PrepareRepositoryResult> = {}): PrepareRepositoryResult {
    return {
        workflow: { state: 'committed', commitSha: SHA, contentSha256: CONTENT_SHA },
        secretsWritten: ['EW_DATABASE_URL'],
        secretsRemoved: [],
        buildInputsHash: INPUTS_HASH,
        ...overrides,
    } as PrepareRepositoryResult;
}

function createHarness(options: { spec?: AppSpec | null } = {}): Harness {
    const store: { row: WorkBuildPreparation | null; builds: WorkBuild[] } = {
        row: null,
        builds: [],
    };
    const upserts: WorkBuildPreparationPatch[] = [];
    const rowsHooks: Harness['rowsHooks'] = {};
    const calls: string[] = [];
    let held = false;

    const context: AppBuildWorkContext = {
        workId: WORK_ID,
        userId: USER_ID,
        trackedBranch: TRACKED,
        buildPluginId: PLUGIN_ID,
        repositoryFullName: FULL_NAME,
        repositoryVisibility: 'public',
    };

    const plugin = {
        prepareRepository: jest.fn(
            async (_input: AppBuildPrepareInput, _auth?: unknown, _writer?: unknown) =>
                prepareResult(),
        ),
        startBuild: jest.fn(
            async (_input: {
                buildId: string;
                ref: string;
                sha: string;
                mode: 'build' | 'verify';
            }) => ({ providerRunId: 'run-1', dispatchedAt: new Date().toISOString() }),
        ),
        setActionsPermissions: jest.fn(async (_input: { workflowPath: string }) => undefined),
        getFileContent: jest.fn(
            async (
                _path: string,
                _ref?: string,
            ): Promise<{ content: string; encoding: string } | null> => null,
        ),
        resolve: jest.fn(async (_workId: string, _userId: string) => binding),
    };

    const mutable = {
        pluginId: PLUGIN_ID,
        buildKind: 'github-actions' as const,
        imageRepository: `ghcr.io/acme/shop/ever-works-app`,
        repository: {
            owner: 'acme',
            repo: 'shop',
            visibility: 'public',
            trackedBranch: TRACKED,
            createdByAppWork: true,
        } as BuildRepositoryRef,
        settings: {},
        writer: { getFileContent: plugin.getFileContent } as never,
        prepareRepository: plugin.prepareRepository,
        startBuild: plugin.startBuild,
        setActionsPermissions: plugin.setActionsPermissions,
    };
    const binding = mutable as unknown as AppBuildPreparePluginBinding;
    plugin.resolve.mockImplementation(async () => binding);

    const env = {
        resolveForBuild: jest.fn(async () => ({
            values: [
                {
                    name: 'DATABASE_URL',
                    value: 'postgres://build/db',
                    secret: true,
                    fingerprint: 'v3',
                },
            ],
            unresolved: [],
            fingerprints: { DATABASE_URL: 'v3' },
            warnings: [],
            missingRequired: [],
            egress: [],
        })),
    };

    const specs = {
        read: jest.fn(
            async (): Promise<AppBuildSpecRead> => ({
                spec: options.spec === undefined ? SPEC : options.spec,
                commitSha: SHA,
                specHash: 'f'.repeat(64),
                valid: true,
            }),
        ),
    };

    const works = { read: jest.fn(async () => context) };

    const service = {
        publish: jest.fn(async () => undefined),
        dispatchPrepare: jest.fn(async () => false),
        dispatchWatch: jest.fn(async () => false),
    };

    const lock: Harness['lock'] = {
        runExclusive: jest.fn(
            async (
                key: string,
                fn: () => Promise<unknown>,
                options2?: { onLocked?: () => void },
            ) => {
                calls.push(key);
                if (held) {
                    options2?.onLocked?.();
                    return { acquired: false };
                }
                held = true;
                try {
                    const result = await fn();
                    if (lock.afterFn) await lock.afterFn();
                    return { acquired: true, result };
                } finally {
                    held = false;
                }
            },
        ),
        calls,
        hold: () => {
            held = true;
        },
        release: () => {
            held = false;
        },
        isHeld: () => held,
    };

    const preparations = {
        findByWork: jest.fn(async () => store.row),
        upsertAfterPrepare: jest.fn(async (_workId: string, patch: WorkBuildPreparationPatch) => {
            upserts.push(patch);
            store.row = { ...(store.row ?? preparationRow()), ...patch } as WorkBuildPreparation;
            return store.row;
        }),
    };

    const builds = {
        findPage: jest.fn(
            async (
                _workId: string,
                filters: { status?: readonly string[]; trigger?: readonly string[] },
            ) => {
                const rows = store.builds
                    .filter((row) => !filters.status || filters.status.includes(row.status))
                    .filter((row) => !filters.trigger || filters.trigger.includes(row.trigger))
                    .sort(
                        (left, right) =>
                            (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0) ||
                            right.number - left.number,
                    );
                return { rows, total: rows.length, page: 1, pageSize: 100, hasMore: false };
            },
        ),
    };

    const runner = new AppBuildPrepareRunner(
        builds as never,
        preparations as never,
        service as unknown as AppBuildsService,
        lock as unknown as DistributedTaskLockService,
        { resolve: plugin.resolve } as never,
        works as never,
        specs as never,
        env as unknown as AppEnvResolver,
        rowsRepository(store, rowsHooks),
    );

    return {
        runner,
        store,
        binding,
        plugin,
        env,
        specs,
        works,
        service,
        upserts,
        rowsHooks,
        repositories: { builds, preparations },
        lock,
        setRepository: (patch: Partial<BuildRepositoryRef>) => {
            mutable.repository = { ...mutable.repository, ...patch };
        },
        prepareCall: (index = 1) =>
            plugin.prepareRepository.mock.calls[index - 1][0] as AppBuildPrepareInput,
        startCall: (index = 1) => plugin.startBuild.mock.calls[index - 1][0] as never,
    };
}

/** One `app-build-prepare` payload (§7.1). */
function payload(reason: string, buildId?: string) {
    return { workId: WORK_ID, reason, ...(buildId ? { buildId } : {}) } as never;
}

/* -------------------------------------------------------------------------- *
 * The pure decisions
 * -------------------------------------------------------------------------- */

describe('selectBuildRunner (FR-22, FR-23, ACC-05-22, APW05-G14)', () => {
    it('allows 14 GiB on a public runner and blocks 15 GiB', () => {
        expect(selectBuildRunner('public', {}, 14)).toMatchObject({
            fits: true,
            runner: expect.objectContaining({ runnerClass: 'github-public', maxMemoryGiB: 14 }),
        });
        expect(selectBuildRunner('public', {}, 15)).toMatchObject({
            fits: false,
            reason: 'runnerTooSmall',
            runner: expect.objectContaining({ runnerClass: 'github-public', maxMemoryGiB: 14 }),
        });
    });

    it('allows 5 GiB on a private runner and blocks 6 GiB', () => {
        expect(selectBuildRunner('private', {}, 5).fits).toBe(true);
        expect(selectBuildRunner('private', {}, 6)).toMatchObject({
            fits: false,
            reason: 'runnerTooSmall',
            runner: expect.objectContaining({ runnerClass: 'github-private', maxMemoryGiB: 5 }),
        });
    });

    it('blocks a 12 GiB private build with no larger runner, and allows it with a 32 GiB one', () => {
        expect(selectBuildRunner('private', {}, 12)).toMatchObject({
            fits: false,
            reason: 'runnerTooSmall',
            runner: expect.objectContaining({ maxMemoryGiB: 5 }),
        });
        expect(
            selectBuildRunner(
                'private',
                {
                    largerRunnerLabel: 'ever-works-32',
                    largerRunnerMemoryGiB: 32,
                    largerRunnerVcpu: 16,
                },
                12,
            ),
        ).toMatchObject({
            fits: true,
            runner: expect.objectContaining({
                runnerClass: 'github-larger',
                label: 'ever-works-32',
                maxMemoryGiB: 30,
            }),
        });
    });

    it('never blocks an absent memory — the runner’s maximum is the answer (APW05-G14)', () => {
        expect(selectBuildRunner('private', {}, undefined).fits).toBe(true);
        expect(selectBuildRunner('public', {}, undefined).fits).toBe(true);
        expect(declaredBuildMemoryGiB(SPEC)).toBe(2);
    });

    it('refuses to guess when a larger runner label has no memory', () => {
        expect(selectBuildRunner('private', { largerRunnerLabel: 'big' }, 1)).toMatchObject({
            fits: false,
            reason: 'runnerMemoryUnknown',
        });
    });
});

describe('mapPluginBlockedReason (the closed set is the authority)', () => {
    it('keeps a reason the platform can render and refuses every other string', () => {
        expect(mapPluginBlockedReason('workflowWriteFailed')).toBe('workflowWriteFailed');
        expect(mapPluginBlockedReason('actionsDisabled')).toBe('actionsDisabled');
        expect(mapPluginBlockedReason('buildServicePortRequired')).toBe('buildServicePortRequired');
        expect(mapPluginBlockedReason('notAReasonTheWebKnows')).toBeNull();
        expect(mapPluginBlockedReason(undefined)).toBeNull();
    });
});

describe('unionMinusRemoved (§4.7, FR-18)', () => {
    it('adds what was written, drops what was removed, and never invents a name', () => {
        expect(unionMinusRemoved(['A', 'B'], ['A', 'C'], ['B'])).toEqual(['A', 'C']);
        expect(unionMinusRemoved([], ['A'], ['B'])).toEqual(['A']);
        expect(unionMinusRemoved(['A'], [], ['A'])).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * Plan §7.2 step 2 — the strategy gate
 * -------------------------------------------------------------------------- */

describe('the strategy gate (plan §7.2 step 2)', () => {
    it.each([
        [
            'image',
            {
                ...NO_BUILD_SPEC,
                build: { strategy: 'image', image: 'ghcr.io/acme/shop:1' },
            } as AppSpec,
        ],
        ['none', NO_BUILD_SPEC],
    ])(
        'an `%s` strategy with no checks records no Build, writes no row and never asks a build plugin',
        async (_strategy, spec) => {
            const harness = createHarness({ spec });
            harness.store.builds = [buildRow({ number: 1 })];

            const result = await harness.runner.run(payload('specApplied'));

            expect(result).toMatchObject({
                status: 'skipped',
                reason: 'nothingToPrepare',
                prepared: false,
                buildsDispatched: 0,
                buildsBlocked: 0,
            });
            // No plugin call of ANY kind — not even a resolution.
            expect(harness.plugin.resolve).not.toHaveBeenCalled();
            expect(harness.plugin.prepareRepository).not.toHaveBeenCalled();
            expect(harness.plugin.startBuild).not.toHaveBeenCalled();
            expect(harness.upserts).toHaveLength(0);
            expect(harness.store.builds[0].status).toBe('queued');
        },
    );

    it('an `auto` strategy blocks the requested Build with `strategyNotSupported` and still writes the checks (R-13)', async () => {
        const harness = createHarness({
            spec: { ...SPEC, build: { ...SPEC.build!, strategy: 'auto' } } as AppSpec,
        });
        harness.store.builds = [buildRow({ number: 1, status: 'queued' })];

        const result = await harness.runner.run(payload('specApplied', 'build-1'));

        expect(result.status).toBe('prepared');
        expect(result.buildsDispatched).toBe(0);
        expect(result.buildsBlocked).toBe(1);
        expect(harness.store.builds[0]).toMatchObject({
            status: 'blocked',
            blockedReason: 'strategyNotSupported',
            blockedDetail: { strategy: 'auto' },
        });
        // "and still write the checks when declared" (`plan.md:1339-1340`).
        expect(harness.plugin.prepareRepository).toHaveBeenCalledTimes(1);
        expect(harness.prepareCall().checks).toEqual([
            { name: 'lint', command: 'npm run lint', required: true, timeoutSeconds: 900 },
        ]);
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(harness.service.dispatchWatch).not.toHaveBeenCalled();
    });

    it('an `image` strategy with one check writes a checks-only workflow and leaves the three secret fields untouched (ACC-05-30)', async () => {
        const harness = createHarness({
            spec: {
                ...SPEC,
                build: { strategy: 'image', image: 'ghcr.io/acme/shop:1' },
            } as AppSpec,
        });
        harness.store.row = preparationRow({
            buildInputsHash: 'old-hash',
            secretsSyncedAt: new Date(2026, 0, 2),
            buildSecretNames: ['EW_DATABASE_URL'],
            workflowSha256: 'd'.repeat(64),
            workflowState: 'committed',
        });

        const result = await harness.runner.run(payload('specApplied'));

        expect(result.status).toBe('prepared');
        expect(harness.plugin.prepareRepository).toHaveBeenCalledTimes(1);
        // Checks-only: NO values, and an EMPTY previous list — an empty values list
        // with a populated previous list is a deletion instruction (§4.7).
        expect(harness.prepareCall()).toMatchObject({
            values: [],
            previouslyWrittenSecretNames: [],
            build: expect.objectContaining({ strategy: 'image' }),
        });
        expect(harness.prepareCall().checks).toHaveLength(1);
        // The three secret fields are untouched: the patch carries none of them.
        expect(harness.upserts).toHaveLength(1);
        expect(harness.upserts[0]).not.toHaveProperty('buildInputsHash');
        expect(harness.upserts[0]).not.toHaveProperty('buildSecretNames');
        expect(harness.upserts[0]).not.toHaveProperty('secretsSyncedAt');
        expect(harness.store.row).toMatchObject({
            buildInputsHash: 'old-hash',
            buildSecretNames: ['EW_DATABASE_URL'],
        });
        expect(result.secretsSynced).toBe(false);
    });
});

/* -------------------------------------------------------------------------- *
 * Plan §7.2 step 3 — build values (ACC-05-14)
 * -------------------------------------------------------------------------- */

describe('build values (plan §7.2 step 3, ACC-05-14)', () => {
    it('a missing required value blocks the requested Build naming it, dispatches nothing, and still delivers the workflow', async () => {
        const harness = createHarness();
        harness.store.builds = [buildRow({ number: 1 })];
        harness.env.resolveForBuild.mockResolvedValueOnce({
            values: [],
            unresolved: [],
            fingerprints: {},
            warnings: [],
            missingRequired: [{ name: 'DATABASE_URL', description: 'The database' }],
            egress: [],
        });

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(harness.store.builds[0]).toMatchObject({
            status: 'blocked',
            blockedReason: 'missingBuildValues',
            blockedDetail: { names: ['DATABASE_URL'] },
        });
        expect(result.buildsBlocked).toBe(1);
        expect(result.buildsDispatched).toBe(0);
        // "blocks the Build before anything runs" is about the dispatch and the
        // secret sync — ACC-05-14's second half needs the workflow on the branch,
        // so a push run can fail in its first step.
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(harness.service.dispatchWatch).not.toHaveBeenCalled();
        expect(harness.plugin.prepareRepository).toHaveBeenCalledTimes(1);
        expect(harness.prepareCall()).toMatchObject({
            values: [],
            previouslyWrittenSecretNames: [],
        });
        // The sync never ran, so no secret field may be written.
        expect(harness.upserts[0]).not.toHaveProperty('buildSecretNames');
    });

    it('hands APW-07’s values to the plugin and stamps the hash, the names and the time on the row', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });

        const result = await harness.runner.run(payload('specApplied'));

        expect(harness.prepareCall().values).toEqual([
            {
                name: 'DATABASE_URL',
                value: 'postgres://build/db',
                secret: true,
                fromBuildService: false,
                fingerprint: 'v3',
            } satisfies BuildValue,
        ]);
        expect(harness.upserts[0]).toMatchObject({
            buildPluginId: PLUGIN_ID,
            buildInputsHash: INPUTS_HASH,
            buildSecretNames: ['EW_DATABASE_URL'],
            workflowState: 'committed',
            workflowSha256: CONTENT_SHA,
        });
        expect(harness.upserts[0].secretsSyncedAt).toBeInstanceOf(Date);
        expect(result.secretsSynced).toBe(true);
        // No Build was requested, so nothing was dispatched — §7.2 step 5's
        // "a `specApplied` prepare with no Build".
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(result.buildsDispatched).toBe(0);
    });

    it('a second prepare passes a removed name in `previouslyWrittenSecretNames` and drops it from the row (APW05-G03)', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.row = preparationRow({
            workflowSha256: CONTENT_SHA,
            workflowState: 'committed',
            buildSecretNames: ['EW_DATABASE_URL', 'EW_APP_SECRET'],
            buildInputsHash: INPUTS_HASH,
            secretsSyncedAt: new Date(2026, 0, 2),
        });
        harness.plugin.prepareRepository.mockResolvedValueOnce(
            prepareResult({
                workflow: { state: 'unchanged', contentSha256: CONTENT_SHA },
                secretsWritten: ['EW_DATABASE_URL'],
                secretsRemoved: ['EW_APP_SECRET'],
            }),
        );

        const result = await harness.runner.run(payload('envChanged'));

        expect(harness.prepareCall().previouslyWrittenSecretNames).toEqual([
            'EW_DATABASE_URL',
            'EW_APP_SECRET',
        ]);
        expect(harness.upserts[0].buildSecretNames).toEqual(['EW_DATABASE_URL']);
        expect(harness.store.row?.buildSecretNames).toEqual(['EW_DATABASE_URL']);
        // `unchanged` keeps `committed` and clears the pull request fields (§3.1b).
        expect(harness.upserts[0]).toMatchObject({
            workflowState: 'committed',
            workflowPullRequestNumber: null,
            workflowPullRequestUrl: null,
        });
        expect(result.workflowState).toBe('committed');
    });
});

/* -------------------------------------------------------------------------- *
 * Plan §7.2 step 4 — the runner fit
 * -------------------------------------------------------------------------- */

describe('the runner fit (plan §7.2 step 4, ACC-05-22)', () => {
    it('blocks a private 12 GiB build with both numbers and dispatches nothing', async () => {
        const harness = createHarness();
        harness.setRepository({ visibility: 'private' });
        harness.store.builds = [buildRow({ number: 1 })];
        const memorySpec = {
            ...SPEC,
            checks: [],
            build: { ...SPEC.build!, resources: { cpu: 2, memory: '12Gi', timeoutMinutes: 60 } },
        } as AppSpec;
        harness.specs.read.mockResolvedValue({
            spec: memorySpec,
            commitSha: SHA,
            specHash: 'f'.repeat(64),
            valid: true,
        });

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(declaredBuildMemoryGiB(memorySpec)).toBe(12);
        expect(harness.store.builds[0]).toMatchObject({
            status: 'blocked',
            blockedReason: 'runnerTooSmall',
            blockedDetail: { needed: 12, max: 5 },
        });
        expect(result.buildsBlocked).toBe(1);
        expect(result.buildsDispatched).toBe(0);
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
    });

    it('does not block a build whose memory is absent (APW05-G14)', async () => {
        const harness = createHarness();
        harness.setRepository({ visibility: 'private' });
        harness.store.builds = [buildRow({ number: 1 })];
        const memorySpec = {
            ...SPEC,
            checks: [],
            build: { ...SPEC.build!, resources: { cpu: 2, timeoutMinutes: 60 } },
        } as AppSpec;
        harness.specs.read.mockResolvedValue({
            spec: memorySpec,
            commitSha: SHA,
            specHash: 'f'.repeat(64),
            valid: true,
        });

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(declaredBuildMemoryGiB(memorySpec)).toBeUndefined();
        expect(harness.store.builds[0].status).toBe('queued');
        expect(harness.store.builds[0].blockedReason ?? null).toBeNull();
        expect(result.buildsDispatched).toBe(1);
        expect(harness.plugin.startBuild).toHaveBeenCalledTimes(1);
    });
});

/* -------------------------------------------------------------------------- *
 * Plan §7.2 steps 5–6 — the row, and the dispatch
 * -------------------------------------------------------------------------- */

describe('the preparation row and the dispatch (plan §7.2 steps 5-6)', () => {
    it('records `workflowWrittenAt` and the state, and dispatches a requested Build on the tracked branch', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(harness.upserts[0]).toMatchObject({
            workflowState: 'committed',
            workflowSha256: CONTENT_SHA,
        });
        expect(harness.upserts[0].workflowWrittenAt).toBeInstanceOf(Date);
        expect(result.buildsDispatched).toBe(1);
        expect(harness.startCall()).toEqual({
            buildId: 'build-1',
            ref: TRACKED,
            sha: SHA,
            mode: 'build',
        });
        expect(harness.store.builds[0].dispatchedAt).toBeInstanceOf(Date);
        expect(harness.store.builds[0].providerRunId).toBe('run-1');
        expect(harness.service.dispatchWatch).toHaveBeenCalledWith({
            buildId: 'build-1',
            reason: 'dispatched',
        });
        // The requested Build carries the three §3.1b stamps it was prepared with.
        expect(harness.store.builds[0]).toMatchObject({
            buildInputsHash: INPUTS_HASH,
            buildSecretNames: ['EW_DATABASE_URL'],
        });
    });

    it('a workflow that landed in a pull request blocks the Build `workflowPending` and dispatches nothing', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.setRepository({ createdByAppWork: false });
        harness.store.builds = [buildRow({ number: 1 })];
        harness.plugin.prepareRepository.mockResolvedValueOnce(
            prepareResult({
                workflow: {
                    state: 'pullRequestOpened',
                    pullRequestUrl: 'https://github.com/acme/shop/pull/12',
                    contentSha256: CONTENT_SHA,
                },
            }),
        );

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(harness.store.builds[0]).toMatchObject({
            status: 'blocked',
            blockedReason: 'workflowPending',
            blockedDetail: { pullRequestUrl: 'https://github.com/acme/shop/pull/12' },
        });
        expect(result.buildsDispatched).toBe(0);
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(harness.service.dispatchWatch).not.toHaveBeenCalled();
        // §3.1b: the pull request state plus its number and URL, and NO stored
        // hash — only a matching read-back on the tracked branch may store one.
        expect(harness.upserts[0]).toMatchObject({
            workflowState: 'pullRequestOpen',
            workflowPullRequestNumber: 12,
            workflowPullRequestUrl: 'https://github.com/acme/shop/pull/12',
        });
        expect(harness.upserts[0]).not.toHaveProperty('workflowSha256');
    });

    it('the plugin’s own `blocked` reason is stored on the row as `repositoryBlock` and blocks the Build', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];
        harness.plugin.prepareRepository.mockResolvedValueOnce(
            prepareResult({
                blocked: { reason: 'actionsDisabled', detail: { enabled: 'false' } },
            }),
        );

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(harness.store.builds[0]).toMatchObject({
            status: 'blocked',
            blockedReason: 'actionsDisabled',
        });
        expect(harness.upserts[0].repositoryBlock).toMatchObject({
            reason: 'actionsDisabled',
            detail: { enabled: 'false' },
        });
        expect(harness.store.row?.repositoryBlock).toMatchObject({ reason: 'actionsDisabled' });
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(result.buildsBlocked).toBe(1);
    });

    it('a `reason: actionsEnabled` prepare calls `setActionsPermissions?` first, then dispatches', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];

        await harness.runner.run(payload('actionsEnabled', 'build-1'));

        expect(harness.plugin.setActionsPermissions).toHaveBeenCalledWith({
            workflowPath: APP_BUILD_WORKFLOW_PATH,
        });
        expect(harness.plugin.setActionsPermissions.mock.invocationCallOrder[0]).toBeLessThan(
            harness.plugin.prepareRepository.mock.invocationCallOrder[0],
        );
        expect(harness.plugin.startBuild).toHaveBeenCalledTimes(1);
    });
});

/* -------------------------------------------------------------------------- *
 * Plan §4.6 step 0 — the verification bootstrap (APW05-G02)
 * -------------------------------------------------------------------------- */

describe('the verification bootstrap (plan §4.6 step 0, APW05-G02)', () => {
    it('delivers exactly one bootstrap commit and then dispatches on the tracked branch', async () => {
        const harness = createHarness({ spec: null });
        harness.store.builds = [
            buildRow({ number: 1, trigger: 'verification', status: 'queued', branch: TRACKED }),
        ];

        const result = await harness.runner.run(payload('verification', 'build-1'));

        expect(harness.plugin.prepareRepository).toHaveBeenCalledTimes(1);
        expect(harness.prepareCall()).toMatchObject({
            bootstrap: true,
            build: null,
            values: [],
            checks: [],
            previouslyWrittenSecretNames: [],
            lastWrittenWorkflowSha256: null,
        });
        // Exactly one bootstrap commit: the delivery ran once, and no request was
        // made for a second one on this dispatch.
        expect(harness.plugin.prepareRepository.mock.calls).toHaveLength(1);
        expect(harness.plugin.startBuild).toHaveBeenCalledTimes(1);
        expect(harness.startCall()).toMatchObject({ mode: 'verify', ref: TRACKED, sha: SHA });
        expect(result.buildsDispatched).toBe(1);
        expect(harness.upserts[0]).toMatchObject({
            workflowState: 'committed',
            workflowSha256: CONTENT_SHA,
        });
    });

    it('blocks with `workflowPending` and dispatches nothing when only the pull request carries the bootstrap (a Link)', async () => {
        const harness = createHarness({ spec: null });
        harness.setRepository({ createdByAppWork: false });
        harness.store.builds = [buildRow({ number: 1, trigger: 'verification', status: 'queued' })];
        harness.plugin.prepareRepository.mockResolvedValueOnce(
            prepareResult({
                workflow: {
                    state: 'pullRequestOpened',
                    pullRequestUrl: 'https://github.com/acme/shop/pull/7',
                    contentSha256: CONTENT_SHA,
                },
                secretsWritten: [],
            }),
        );

        const result = await harness.runner.run(payload('verification', 'build-1'));

        expect(harness.prepareCall()).toMatchObject({ bootstrap: true });
        expect(harness.store.builds[0]).toMatchObject({
            status: 'blocked',
            blockedReason: 'workflowPending',
            blockedDetail: { pullRequestUrl: 'https://github.com/acme/shop/pull/7' },
        });
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(harness.service.dispatchWatch).not.toHaveBeenCalled();
        expect(result.buildsDispatched).toBe(0);
        expect(result.buildsBlocked).toBe(1);
    });

    it('a verification whose workflow is already on the tracked branch writes nothing and dispatches', async () => {
        const harness = createHarness({ spec: null });
        harness.store.builds = [buildRow({ number: 1, trigger: 'verification' })];
        harness.plugin.getFileContent.mockResolvedValueOnce({
            content: 'name: build',
            encoding: 'utf-8',
        });

        const result = await harness.runner.run(payload('verification', 'build-1'));

        expect(harness.plugin.getFileContent).toHaveBeenCalledWith(APP_BUILD_WORKFLOW_PATH);
        expect(harness.plugin.prepareRepository).not.toHaveBeenCalled();
        expect(harness.upserts).toHaveLength(0);
        expect(harness.plugin.startBuild).toHaveBeenCalledTimes(1);
        expect(result.buildsDispatched).toBe(1);
    });
});

/* -------------------------------------------------------------------------- *
 * Plan §7.2 step 7 — the blocked-Build retry (APW05-G15)
 * -------------------------------------------------------------------------- */

describe('the blocked-Build retry (plan §7.2 step 7, APW05-G15)', () => {
    it('re-queues the newest blocked manual Build, publishes `app.build.queued` once, and cancels the older one as superseded', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [
            buildRow({
                number: 1,
                status: 'blocked',
                blockedReason: 'missingBuildValues',
                blockedDetail: { names: ['DATABASE_URL'] },
                createdAt: new Date(2026, 0, 1),
            }),
            buildRow({
                number: 2,
                status: 'blocked',
                blockedReason: 'missingBuildValues',
                blockedDetail: { names: ['DATABASE_URL'] },
                createdAt: new Date(2026, 0, 2),
            }),
        ];

        const result = await harness.runner.run(payload('envChanged'));

        const [older, newest] = harness.store.builds;
        expect(newest).toMatchObject({
            status: 'queued',
            blockedReason: null,
            blockedDetail: null,
        });
        expect(newest.queuedAt).toBeInstanceOf(Date);
        expect(older).toMatchObject({ status: 'cancelled', cancelReason: 'superseded' });
        // Exactly one `app.build.queued`, and it is the retried Build's.
        expect(harness.service.publish).toHaveBeenCalledTimes(1);
        expect(harness.service.publish.mock.calls[0][0]).toMatchObject({
            id: 'build-2',
            number: 2,
        });
        expect(harness.service.publish.mock.calls[0][1]).toBe('app.build.queued');
        expect(harness.plugin.startBuild).toHaveBeenCalledTimes(1);
        expect(harness.startCall()).toMatchObject({ buildId: 'build-2' });
        expect(result.buildsDispatched).toBe(1);
    });

    it('leaves a blocked Build alone when its commit is not the commit the spec was read at', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [
            buildRow({
                number: 1,
                status: 'blocked',
                blockedReason: 'runnerTooSmall',
                commitSha: 'b'.repeat(40),
            }),
        ];
        harness.specs.read.mockResolvedValue({
            spec: { ...SPEC, checks: [] } as AppSpec,
            commitSha: SHA,
            specHash: 'f'.repeat(64),
            valid: true,
        });

        const result = await harness.runner.run(payload('envChanged'));

        expect(harness.store.builds[0].status).toBe('blocked');
        expect(harness.service.publish).not.toHaveBeenCalled();
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(result.buildsDispatched).toBe(0);
    });

    it('does not touch a verification Build — the plan is not stored, so APW-04 asks again', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [
            buildRow({
                number: 1,
                status: 'blocked',
                trigger: 'verification',
                blockedReason: 'workflowPending',
            }),
        ];

        await harness.runner.run(payload('specApplied'));

        expect(harness.store.builds[0].status).toBe('blocked');
        expect(harness.service.publish).not.toHaveBeenCalled();
    });
});

/* -------------------------------------------------------------------------- *
 * Plan §7.2 — the coalescing loop (APW05-G17)
 * -------------------------------------------------------------------------- */

describe('the coalescing loop (plan §7.2, APW05-G17)', () => {
    it('runs the passes the loop allows while `prepareSeq` keeps moving, then asks for one coalesced dispatch', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        let seq = 0;
        // Every read of the row advances the marker, which is what a concurrent
        // requester does: the loop must see movement after EVERY pass.
        const preparations = {
            findByWork: jest.fn(async () => {
                seq += 1;
                return preparationRow({ prepareSeq: seq });
            }),
            upsertAfterPrepare: jest.fn(
                async (_workId: string, patch: WorkBuildPreparationPatch) => {
                    harness.upserts.push(patch);
                    return preparationRow({ ...patch });
                },
            ),
        };
        const runner = new AppBuildPrepareRunner(
            {
                findPage: jest.fn(async () => ({
                    rows: [],
                    total: 0,
                    page: 1,
                    pageSize: 100,
                    hasMore: false,
                })),
            } as never,
            preparations as never,
            harness.service as unknown as AppBuildsService,
            harness.lock as unknown as DistributedTaskLockService,
            { resolve: harness.plugin.resolve } as never,
            harness.works as never,
            harness.specs as never,
            harness.env as unknown as AppEnvResolver,
            rowsRepository(harness.store),
        );
        // Whether the lock was still held when the coalescing dispatch was made.
        // A dispatch made under the lock is answered `locked` by a fast runtime
        // (the §7.2 lock is taken first thing), and the request it carries is lost.
        const heldAtDispatch: boolean[] = [];
        harness.service.dispatchPrepare.mockImplementation(async () => {
            heldAtDispatch.push(harness.lock.isHeld());
            return false;
        });

        const result = await runner.run(payload('coalesced'));

        // The plan's own number (`plan.md:1373`: "at most, three passes"), written
        // as a literal on purpose: `result.passes` compared against the exported
        // constant alone would pass for ANY value the constant took, including the
        // 1 that turns the loop off.
        expect(result.passes).toBe(3);
        expect(APP_BUILD_PREPARE_MAX_PASSES).toBe(3);
        expect(harness.plugin.prepareRepository).toHaveBeenCalledTimes(3);
        expect(result.coalesced).toBe(true);
        expect(harness.service.dispatchPrepare).toHaveBeenCalledTimes(1);
        expect(harness.service.dispatchPrepare).toHaveBeenCalledWith({
            workId: WORK_ID,
            reason: 'coalesced',
        });
        // ...and it is made AFTER the lock is released, never under it.
        expect(heldAtDispatch).toEqual([false]);
    });

    it('re-reads `prepareSeq` after releasing the lock: a request that saw `locked` in the release window is coalesced', async () => {
        // Plan §7.2 (`plan.md:1366-1382`): "the holder re-reads it after
        // releasing". The window is between the loop's LAST `prepareSeq` read and
        // the lock release. A requester that bumps there and then dispatches is
        // answered `locked` — and before this fix nothing ever looked at its bump.
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];
        let second: unknown;
        harness.lock.afterFn = async () => {
            harness.lock.afterFn = undefined;
            // The requester: its durable change (a new Build), its bump, then its
            // dispatch — which finds the lock still held.
            harness.store.builds.push(buildRow({ number: 2 }));
            harness.store.row!.prepareSeq = (harness.store.row!.prepareSeq ?? 0) + 1;
            second = await harness.runner.run(payload('rebuild', 'build-2'));
        };

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(second).toMatchObject({ status: 'skipped', reason: 'locked' });
        expect(result).toMatchObject({ status: 'prepared', buildsDispatched: 1 });
        // Build 2 was not dispatched by the holder (it was created after the last
        // pass read its Builds) — so exactly one coalescing prepare picks it up.
        expect(harness.store.builds[1].dispatchedAt ?? null).toBeNull();
        expect(harness.service.dispatchPrepare).toHaveBeenCalledTimes(1);
        expect(harness.service.dispatchPrepare).toHaveBeenCalledWith({
            workId: WORK_ID,
            reason: 'coalesced',
        });
        expect(result.coalesced).toBe(true);
    });

    it('asks for no coalescing prepare when nothing moved while the lock was held', async () => {
        // The control for the re-read above: a quiet Work is not re-prepared.
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(result).toMatchObject({ status: 'prepared', coalesced: false });
        expect(harness.service.dispatchPrepare).not.toHaveBeenCalled();
    });

    it('a dispatch that cannot take the lock exits as `skipped` and loses nothing', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];

        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        harness.plugin.prepareRepository.mockImplementationOnce(async () => {
            await gate;
            return prepareResult();
        });

        const first = harness.runner.run(payload('rebuild', 'build-1'));
        // Let the first dispatch take the lock and reach the provider call.
        await new Promise((resolve) => setImmediate(resolve));

        const second = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(second).toMatchObject({ status: 'skipped', reason: 'locked', buildsDispatched: 0 });
        expect(harness.lock.calls).toEqual([
            appBuildPrepareLockKey(WORK_ID),
            appBuildPrepareLockKey(WORK_ID),
        ]);
        // The lock is the ONLY reason the second run did nothing: the request is
        // not lost, because the holder numbers the Builds from the database.
        expect(harness.plugin.prepareRepository).toHaveBeenCalledTimes(1);

        release();
        const firstResult = await first;
        expect(firstResult).toMatchObject({ status: 'prepared', buildsDispatched: 1 });
        expect(harness.plugin.startBuild).toHaveBeenCalledTimes(1);
    });

    describe('a pass that throws (the after-release re-read is bounded)', () => {
        it('a run that never read `prepareSeq` dispatches nothing — a persistent read fault cannot chain runs', async () => {
            // The trigger the review measured: a payload whose `workId` is not a
            // UUID, on Postgres. The lock key is varchar, so the lock is taken;
            // `work_build_preparations.workId` is `uuid`, so EVERY read of the row
            // fails. A run that dispatched a coalesced prepare here would start a
            // run that fails the same way and dispatches the next — without end
            // (the review's probe: 25 runs, 25 dispatches, stopped only by its cap).
            const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
            harness.store.builds = [buildRow({ number: 1 })];
            const fault = new Error('invalid input syntax for type uuid: "not-a-uuid"');
            (harness.repositories.preparations as { findByWork: jest.Mock }).findByWork
                .mockReset()
                .mockRejectedValue(fault);
            // Each coalesced dispatch starts a fresh run of the same runner — the
            // chain the in-process fallback turns into a busy loop. Capped, so a
            // regression reddens instead of hanging.
            let runs = 1;
            harness.service.dispatchPrepare.mockImplementation(async (next: never) => {
                if (runs < 25) {
                    runs += 1;
                    void harness.runner.run(next).catch(() => undefined);
                }
                return false;
            });

            await expect(harness.runner.run(payload('rebuild', 'build-1'))).rejects.toThrow(
                'invalid input syntax for type uuid',
            );
            await new Promise((resolve) => setImmediate(resolve));

            expect(harness.service.dispatchPrepare).not.toHaveBeenCalled();
            expect(runs).toBe(1);
            expect(harness.plugin.prepareRepository).not.toHaveBeenCalled();
            expect(harness.plugin.startBuild).not.toHaveBeenCalled();
            // The lock was released: the next request is not answered `locked`.
            expect(harness.lock.isHeld()).toBe(false);
        });

        it('a pass that throws after `prepareSeq` moved asks for exactly one coalesced prepare', async () => {
            // A requester that met the lock while the failing pass held it bumped
            // BEFORE it tried the lock; its request is only safe if the holder
            // looks again after releasing, whatever the pass did.
            const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
            harness.store.row = preparationRow({ prepareSeq: 3 });
            harness.store.builds = [buildRow({ number: 1 })];
            const heldAtDispatch: boolean[] = [];
            harness.service.dispatchPrepare.mockImplementation(async () => {
                heldAtDispatch.push(harness.lock.isHeld());
                return false;
            });
            harness.plugin.prepareRepository.mockImplementationOnce(async () => {
                harness.store.row!.prepareSeq = 4;
                throw new Error('GitHub answered 502');
            });

            await expect(harness.runner.run(payload('rebuild', 'build-1'))).rejects.toThrow(
                'GitHub answered 502',
            );

            expect(harness.service.dispatchPrepare).toHaveBeenCalledTimes(1);
            expect(harness.service.dispatchPrepare).toHaveBeenCalledWith({
                workId: WORK_ID,
                reason: 'coalesced',
            });
            expect(heldAtDispatch).toEqual([false]);
            expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        });

        it('a pass that throws while `prepareSeq` did not move asks for no coalesced prepare', async () => {
            // The control: a failed prepare is reported, not retried by this file
            // (see the runner's header) — only a request that met the lock earns
            // the one coalesced dispatch.
            const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
            harness.store.row = preparationRow({ prepareSeq: 3 });
            harness.store.builds = [buildRow({ number: 1 })];
            harness.plugin.prepareRepository.mockImplementationOnce(async () => {
                throw new Error('GitHub answered 502');
            });

            await expect(harness.runner.run(payload('rebuild', 'build-1'))).rejects.toThrow(
                'GitHub answered 502',
            );

            expect(harness.service.dispatchPrepare).not.toHaveBeenCalled();
        });

        it('a re-read that fails AFTER the loop read `prepareSeq` still asks for one coalesced prepare', async () => {
            // The loop did read the marker, so a request may have met the lock
            // since: a spare prepare re-delivers idempotently, a lost one waits.
            // The next run's FIRST read decides whether the chain goes on (the
            // first case of this block proves a failing first read ends it).
            const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
            harness.store.row = preparationRow({ prepareSeq: 3 });
            harness.store.builds = [buildRow({ number: 1 })];
            const findByWork = (harness.repositories.preparations as { findByWork: jest.Mock })
                .findByWork;
            let reads = 0;
            findByWork.mockImplementation(async () => {
                reads += 1;
                // Read 1: the loop's marker; read 2: the pass's row. Everything
                // after the pass's failure — the after-release re-read — fails.
                if (reads > 2) throw new Error('connection terminated unexpectedly');
                return harness.store.row;
            });
            harness.plugin.prepareRepository.mockImplementationOnce(async () => {
                throw new Error('GitHub answered 502');
            });

            await expect(harness.runner.run(payload('rebuild', 'build-1'))).rejects.toThrow(
                'GitHub answered 502',
            );

            expect(reads).toBe(3);
            expect(harness.service.dispatchPrepare).toHaveBeenCalledTimes(1);
            expect(harness.service.dispatchPrepare).toHaveBeenCalledWith({
                workId: WORK_ID,
                reason: 'coalesced',
            });
        });
    });
});

/* -------------------------------------------------------------------------- *
 * Unconfigured installations answer by name
 * -------------------------------------------------------------------------- */

describe('an unconfigured installation answers a named skip', () => {
    it.each([
        ['workUnavailable', (h: Harness) => h.works.read.mockResolvedValueOnce(null)],
        ['pluginUnavailable', (h: Harness) => h.plugin.resolve.mockResolvedValueOnce(null)],
        ['specUnavailable', (h: Harness) => h.specs.read.mockResolvedValueOnce(null)],
        [
            'buildValuesUnavailable',
            (h: Harness) =>
                h.env.resolveForBuild.mockRejectedValueOnce(
                    new Error('APP_ENV_SPEC_SOURCE unbound'),
                ),
        ],
    ])('%s', async (reason, breakIt) => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];
        breakIt(harness);

        const result = await harness.runner.run(payload('specApplied'));

        expect(result).toMatchObject({ status: 'skipped', reason, prepared: false });
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(harness.service.dispatchWatch).not.toHaveBeenCalled();
        // A skipped prepare never pretends a workflow exists.
        expect(harness.upserts.every((patch) => patch.workflowSha256 === undefined)).toBe(true);
    });

    it('skips by name when the distributed lock is not bound at all', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        const runner = new AppBuildPrepareRunner(
            { findPage: jest.fn() } as never,
            { findByWork: jest.fn(), upsertAfterPrepare: jest.fn() } as never,
            harness.service as unknown as AppBuildsService,
            undefined,
            { resolve: harness.plugin.resolve } as never,
            harness.works as never,
            harness.specs as never,
            harness.env as unknown as AppEnvResolver,
            rowsRepository(harness.store),
        );

        const result = await runner.run(payload('specApplied'));

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'lockUnavailable',
            jobId: APP_BUILD_PREPARE_JOB_ID,
        });
        expect(harness.plugin.resolve).not.toHaveBeenCalled();
    });

    it('an unknown work id in the payload is refused by name, never guessed at', async () => {
        const harness = createHarness();

        const result = await harness.runner.run({ reason: 'specApplied' } as never);

        expect(result).toMatchObject({ status: 'skipped', reason: 'invalidPayload', workId: null });
        expect(harness.lock.runExclusive).not.toHaveBeenCalled();
    });
});

/* -------------------------------------------------------------------------- *
 * T42 — the checks-only prepare (R-9, plan §7.2 step 2, §4.14, ACC-05-30)
 * -------------------------------------------------------------------------- */

/** An `image` Work with `SPEC`'s one check, and a `none` one — ACC-05-30's two strategies. */
function checksOnlySpec(strategy: 'image' | 'none', checks = SPEC.checks): AppSpec {
    return {
        ...SPEC,
        build:
            strategy === 'image'
                ? ({ strategy: 'image' } as AppSpec['build'])
                : ({ strategy: 'none' } as AppSpec['build']),
        checks,
    } as AppSpec;
}

describe('the checks-only prepare (T42, R-9, ACC-05-30)', () => {
    it.each(['image', 'none'] as const)(
        'an `%s` Work with a check calls prepareRepository with zero values and creates no Build',
        async (strategy) => {
            const harness = createHarness({ spec: checksOnlySpec(strategy) });

            const result = await harness.runner.run(payload('specApplied'));

            // ACC-05-30's first half: the checks go to the plugin...
            expect(result.status).toBe('prepared');
            expect(harness.plugin.prepareRepository).toHaveBeenCalledTimes(1);
            expect(harness.prepareCall().checks).toEqual([
                { name: 'lint', command: 'npm run lint', required: true, timeoutSeconds: 900 },
            ]);
            // ...with zero values, and never a previous-name list that an empty
            // `values` would turn into a deletion instruction (§4.7, FR-18).
            expect(harness.prepareCall()).toMatchObject({
                values: [],
                previouslyWrittenSecretNames: [],
            });
            // The build values are not even resolved: no secret is written for a
            // Work that has no Build to read one.
            expect(harness.env.resolveForBuild).not.toHaveBeenCalled();
            expect(result.secretsSynced).toBe(false);
            expect(harness.upserts).toHaveLength(1);
            expect(harness.upserts[0]).not.toHaveProperty('buildInputsHash');
            expect(harness.upserts[0]).not.toHaveProperty('buildSecretNames');
            expect(harness.upserts[0]).not.toHaveProperty('secretsSyncedAt');
            // ACC-05-30's second half, at this seam: nothing is created, adopted or
            // dispatched — no Build row, no `startBuild`, no watch.
            expect(harness.plugin.startBuild).not.toHaveBeenCalled();
            expect(harness.service.dispatchWatch).not.toHaveBeenCalled();
            expect(harness.store.builds).toHaveLength(0);
            expect(result.buildsDispatched).toBe(0);
            expect(result.buildsBlocked).toBe(0);
        },
    );

    it('an `image` Work whose check is removed still prepares, so the file can be proposed for removal (ACC-05-30)', async () => {
        // §4.6 step 8 / FR-70: with no checks left, nothing is written — and an
        // existing checks-only file the platform wrote is replaced by a pull
        // request removing the jobs. That delivery only happens because this
        // prepare is NOT skipped: `platformWroteAWorkflow(row)` is what separates
        // "there is something to remove" from `nothingToPrepare`.
        const harness = createHarness({ spec: checksOnlySpec('image', []) });
        harness.store.row = preparationRow({
            workflowSha256: 'd'.repeat(64),
            workflowState: 'committed',
        });

        const result = await harness.runner.run(payload('specApplied'));

        expect(result.status).toBe('prepared');
        expect(result.reason).toBeNull();
        expect(harness.plugin.prepareRepository).toHaveBeenCalledTimes(1);
        expect(harness.prepareCall()).toMatchObject({
            values: [],
            previouslyWrittenSecretNames: [],
            checks: [],
        });
        expect(harness.env.resolveForBuild).not.toHaveBeenCalled();
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();

        // The control: with no file the platform ever wrote, the same spec is
        // `nothingToPrepare` — nothing to write and nothing to remove.
        const bare = createHarness({ spec: checksOnlySpec('image', []) });
        expect(await bare.runner.run(payload('specApplied'))).toMatchObject({
            status: 'skipped',
            reason: 'nothingToPrepare',
        });
        expect(bare.plugin.prepareRepository).not.toHaveBeenCalled();
    });

    it('an `auto` Work with a check is checks-only too: no secret sync, still no dispatch (R-13, §4.14)', async () => {
        const harness = createHarness({
            spec: { ...SPEC, build: { ...SPEC.build!, strategy: 'auto' } } as AppSpec,
        });
        harness.store.builds = [buildRow({ number: 1, status: 'queued' })];

        const result = await harness.runner.run(payload('specApplied', 'build-1'));

        // §4.14's observation groups `auto` with `image`/`none` as a checks-only
        // run, and §7.2 step 2 blocks its requested Build — so the sync does not
        // run for it either: no value is written for a Build that cannot start.
        expect(harness.env.resolveForBuild).not.toHaveBeenCalled();
        expect(harness.prepareCall()).toMatchObject({
            values: [],
            previouslyWrittenSecretNames: [],
        });
        expect(harness.prepareCall().checks).toHaveLength(1);
        expect(harness.upserts[0]).not.toHaveProperty('buildSecretNames');
        expect(harness.upserts[0]).not.toHaveProperty('secretsSyncedAt');
        expect(result.secretsSynced).toBe(false);
        // Unchanged from T19: the requested Build is blocked, not dispatched.
        expect(harness.store.builds[0]).toMatchObject({
            status: 'blocked',
            blockedReason: 'strategyNotSupported',
        });
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(result.buildsDispatched).toBe(0);

        // The control: `auto` with NO check keeps the sync it had before T42 —
        // only a checks-only run skips it.
        const withoutChecks = createHarness({
            spec: { ...SPEC, build: { ...SPEC.build!, strategy: 'auto' }, checks: [] } as AppSpec,
        });
        await withoutChecks.runner.run(payload('specApplied'));
        expect(withoutChecks.env.resolveForBuild).toHaveBeenCalledTimes(1);
        expect(withoutChecks.prepareCall().values).toHaveLength(1);
    });
});

/* -------------------------------------------------------------------------- *
 * ACC-05-02 — the stored workflow pull request travels to the plugin
 * -------------------------------------------------------------------------- */

describe('the stored workflow pull request (ACC-05-02, plan §4.6 step 3)', () => {
    it('passes the row’s pull request number and URL into prepareRepository, so the plugin can adopt the open one', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.setRepository({ createdByAppWork: false });
        harness.store.row = preparationRow({
            workflowState: 'pullRequestOpen',
            workflowPullRequestNumber: 7,
            workflowPullRequestUrl: 'https://github.com/acme/shop/pull/7',
        });
        harness.plugin.prepareRepository.mockResolvedValueOnce(
            prepareResult({
                workflow: {
                    state: 'pullRequestUpdated',
                    pullRequestUrl: 'https://github.com/acme/shop/pull/7',
                    contentSha256: CONTENT_SHA,
                },
            }),
        );

        await harness.runner.run(payload('specApplied'));

        expect(harness.prepareCall(1)).toMatchObject({
            workflowPullRequestNumber: 7,
            workflowPullRequestUrl: 'https://github.com/acme/shop/pull/7',
        });
    });

    it('passes explicit nulls when the row records no pull request', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });

        await harness.runner.run(payload('specApplied'));

        expect(harness.prepareCall(1)).toMatchObject({
            workflowPullRequestNumber: null,
            workflowPullRequestUrl: null,
        });
    });
});

/* -------------------------------------------------------------------------- *
 * Plan §7.2 — the lock is held ≤ 5 minutes, and a pass stops starting work
 * -------------------------------------------------------------------------- */

describe('the prepare lock’s 5-minute cap (plan §7.2 "held ≤ 5 minutes")', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    /** A controllable `Date.now()` — the runner's lease clock. */
    function clockAt(start: number): { now: number } {
        const clock = { now: start };
        jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
        return clock;
    }

    it('takes the lock with a 5-minute lifetime, not the lock service’s 24 h default', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });

        await harness.runner.run(payload('specApplied'));

        expect(harness.lock.runExclusive).toHaveBeenCalledWith(
            appBuildPrepareLockKey(WORK_ID),
            expect.any(Function),
            expect.objectContaining({ ttlMs: 300_000, maxLifetimeMs: 300_000 }),
        );
        expect(APP_BUILD_PREPARE_LOCK_TTL_MS).toBe(300_000);
    });

    it('with the REAL lock service, a pass stuck for 30 minutes never extends the lease past 5 minutes', async () => {
        jest.useFakeTimers({ now: 0 });
        const expiries: number[] = [];
        let refreshes = 0;
        const queryBuilder = {
            delete: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            update: jest.fn(() => {
                refreshes += 1;
                return queryBuilder;
            }),
            set: jest.fn((patch: { expiresAt: number }) => {
                expiries.push(patch.expiresAt);
                return queryBuilder;
            }),
            execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        const cacheEntries = {
            createQueryBuilder: jest.fn(() => queryBuilder),
            insert: jest.fn(async (row: { expiresAt: number }) => {
                expiries.push(row.expiresAt);
                return {};
            }),
            findOne: jest.fn(async () => null),
        };
        const locks = new DistributedTaskLockService(cacheEntries as never);

        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.plugin.prepareRepository.mockImplementationOnce(
            () =>
                new Promise<PrepareRepositoryResult>((resolve) =>
                    setTimeout(() => resolve(prepareResult()), 30 * 60_000),
                ),
        );
        const runner = new AppBuildPrepareRunner(
            harness.repositories.builds as never,
            harness.repositories.preparations as never,
            harness.service as unknown as AppBuildsService,
            locks,
            { resolve: harness.plugin.resolve } as never,
            harness.works as never,
            harness.specs as never,
            harness.env as unknown as AppEnvResolver,
            rowsRepository(harness.store),
        );

        const running = runner.run(payload('specApplied'));
        await jest.advanceTimersByTimeAsync(30 * 60_000 + 1);
        await running;

        // ttl = lifetime = 5 min: refreshed at 100 s and 200 s, then the hard
        // deadline stops the heartbeat. Before the cap: 18 refreshes and an
        // expiry 35 minutes out, for as long as the holder lived (up to 24 h).
        expect(refreshes).toBeLessThanOrEqual(2);
        expect(Math.max(...expiries)).toBeLessThanOrEqual(300_000);
    });

    it('a pass that reaches the lease deadline starts no Build and asks for one coalesced prepare', async () => {
        const clock = clockAt(1_000_000);
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];
        harness.plugin.prepareRepository.mockImplementationOnce(async () => {
            // The delivery ends 1 ms past `ttl - margin` = 4 min 30 s.
            clock.now = 1_000_000 + 270_001;
            return prepareResult();
        });

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(APP_BUILD_PREPARE_LEASE_MARGIN_MS).toBe(30_000);
        // The delivery that was in flight is recorded — it is what the provider
        // now holds — but nothing NEW is started with it.
        expect(harness.upserts).toHaveLength(1);
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(harness.store.builds[0]).toMatchObject({ status: 'queued' });
        expect(harness.store.builds[0].dispatchedAt ?? null).toBeNull();
        expect(harness.service.dispatchWatch).not.toHaveBeenCalled();
        // One coalesced prepare picks the Build up with a fresh lease.
        expect(harness.service.dispatchPrepare).toHaveBeenCalledTimes(1);
        expect(harness.service.dispatchPrepare).toHaveBeenCalledWith({
            workId: WORK_ID,
            reason: 'coalesced',
        });
        expect(result).toMatchObject({
            status: 'prepared',
            reason: 'leaseExpired',
            coalesced: true,
            buildsDispatched: 0,
        });
    });

    it('a pass that is still inside the lease dispatches as before (the control)', async () => {
        const clock = clockAt(1_000_000);
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];
        harness.plugin.prepareRepository.mockImplementationOnce(async () => {
            clock.now = 1_000_000 + 269_999;
            return prepareResult();
        });

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(harness.plugin.startBuild).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ status: 'prepared', reason: null, coalesced: false });
        expect(harness.service.dispatchPrepare).not.toHaveBeenCalled();
    });

    it('a pass that crosses the deadline before its delivery makes no provider call at all', async () => {
        const clock = clockAt(1_000_000);
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];
        // The reads before the delivery are slow enough to cross the deadline.
        harness.env.resolveForBuild.mockImplementationOnce(async () => {
            clock.now = 1_000_000 + 270_001;
            return {
                values: [],
                unresolved: [],
                fingerprints: {},
                warnings: [],
                missingRequired: [],
                egress: [],
            };
        });

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(harness.plugin.prepareRepository).not.toHaveBeenCalled();
        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(harness.upserts).toHaveLength(0);
        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'leaseExpired',
            coalesced: true,
        });
        expect(harness.service.dispatchPrepare).toHaveBeenCalledTimes(1);
    });

    it('no new pass starts after the deadline, and one coalesced prepare is asked for', async () => {
        const clock = clockAt(1_000_000);
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        let seq = 0;
        // `prepareSeq` moves on every read, as in the coalescing case above:
        // without the deadline the loop would run three passes.
        const preparations = {
            findByWork: jest.fn(async () => {
                seq += 1;
                return preparationRow({ prepareSeq: seq });
            }),
            upsertAfterPrepare: jest.fn(
                async (_workId: string, patch: WorkBuildPreparationPatch) => {
                    harness.upserts.push(patch);
                    return preparationRow({ ...patch });
                },
            ),
        };
        harness.plugin.prepareRepository.mockImplementationOnce(async () => {
            clock.now = 1_000_000 + 270_001;
            return prepareResult();
        });
        const runner = new AppBuildPrepareRunner(
            harness.repositories.builds as never,
            preparations as never,
            harness.service as unknown as AppBuildsService,
            harness.lock as unknown as DistributedTaskLockService,
            { resolve: harness.plugin.resolve } as never,
            harness.works as never,
            harness.specs as never,
            harness.env as unknown as AppEnvResolver,
            rowsRepository(harness.store),
        );

        const result = await runner.run(payload('coalesced'));

        expect(result.passes).toBe(1);
        expect(harness.plugin.prepareRepository).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ reason: 'leaseExpired', coalesced: true });
        expect(harness.service.dispatchPrepare).toHaveBeenCalledTimes(1);
        expect(harness.service.dispatchPrepare).toHaveBeenCalledWith({
            workId: WORK_ID,
            reason: 'coalesced',
        });
    });
});

/* -------------------------------------------------------------------------- *
 * Step 6 — a Build is CLAIMED before `startBuild`, so it is started once
 * -------------------------------------------------------------------------- */

describe('the dispatch claim (dispatchedAt is stamped before startBuild)', () => {
    it('a database error after the dispatch landed never starts the same Build twice', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];
        // The write that records the provider's run fails — the window the
        // worker task's "Budget" names: GitHub has the run, the row does not.
        harness.rowsHooks.beforeExecute = (fields) => {
            if (fields.providerRunId) throw new Error('database unavailable');
        };

        await harness.runner.run(payload('rebuild', 'build-1')).catch(() => undefined);
        await harness.runner.run(payload('rebuild', 'build-1')).catch(() => undefined);

        expect(harness.plugin.startBuild).toHaveBeenCalledTimes(1);
        // The claim keeps the Build out of the next pass's selection.
        expect(harness.store.builds[0].dispatchedAt).toBeInstanceOf(Date);
        expect(harness.store.builds[0].status).toBe('queued');
    });

    it('a startBuild that throws releases the claim, and the next pass retries it', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];
        harness.plugin.startBuild.mockRejectedValueOnce(new Error('GitHub 502'));

        const first = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(first.buildsDispatched).toBe(0);
        expect(harness.store.builds[0].status).toBe('queued');
        expect(harness.store.builds[0].dispatchedAt ?? null).toBeNull();

        const second = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(harness.plugin.startBuild).toHaveBeenCalledTimes(2);
        expect(second.buildsDispatched).toBe(1);
        expect(harness.store.builds[0].providerRunId).toBe('run-1');
        expect(harness.store.builds[0].dispatchedAt).toBeInstanceOf(Date);
    });

    it('a Build another pass claimed after this pass read it is never passed to startBuild', async () => {
        const harness = createHarness({ spec: { ...SPEC, checks: [] } as AppSpec });
        harness.store.builds = [buildRow({ number: 1 })];
        // This pass has already read the Build (dispatchedAt NULL); while it
        // delivers, another pass claims it in the database.
        harness.plugin.prepareRepository.mockImplementationOnce(async () => {
            harness.store.builds[0] = {
                ...harness.store.builds[0],
                dispatchedAt: new Date(2026, 0, 5),
            } as WorkBuild;
            return prepareResult();
        });

        const result = await harness.runner.run(payload('rebuild', 'build-1'));

        expect(harness.plugin.startBuild).not.toHaveBeenCalled();
        expect(harness.service.dispatchWatch).not.toHaveBeenCalled();
        expect(result.buildsDispatched).toBe(0);
    });
});
