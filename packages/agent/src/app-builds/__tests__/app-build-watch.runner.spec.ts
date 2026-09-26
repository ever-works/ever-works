import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Repository } from 'typeorm';
import {
    APP_BUILD_VERIFY_PROMPTED_SECRET,
    computeBuildInputsHash,
    type AppBuildEventPayload,
    type AppSpec,
} from '@ever-works/contracts';
import type { BuildSnapshot } from '@ever-works/plugin';
import type { AppEnvService } from '../../app-env/app-env.service';
import type { ActivityLogService } from '../../activity-log/activity-log.service';
import type { AppBuildPreparationRepository } from '../../database/repositories/app-build-preparation.repository';
import type { AppBuildRepository } from '../../database/repositories/app-build.repository';
import type { CreateActivityLogDto } from '../../entities/activity-log.types';
import { WorkBuild } from '../../entities/work-build.entity';
import { WorkBuildPreparation } from '../../entities/work-build-preparation.entity';
import type { PluginUsageService, RecordPluginUsageInput } from '../../usage/plugin-usage.service';
// APW-05 T18 — the job id the dispatcher enqueues under. Imported so the id this
// suite pins is the one on the wire, not a copy of it.
import { APP_BUILD_WATCH_TASK_ID as AGENT_WATCH_TASK_ID } from '../../tasks/app-build-watch.types';
import {
    APP_BUILD_PLUGIN_RESOLVER,
    APP_BUILD_SPEC_SOURCE,
    APP_BUILD_WORK_SOURCE,
    AppBuildsService,
    type AppBuildSpecRead,
    type AppBuildWorkContext,
} from '../app-builds.service';
import {
    APP_BUILD_WATCH_JOB_ID,
    APP_BUILD_WATCH_LEASE_MS,
    APP_BUILD_WATCH_MAX_CONCURRENT_RUNS,
    APP_BUILD_WATCH_SKIP_REASONS,
    AppBuildWatchRunner,
    repositoryCoordinates,
    type AppBuildWatchPluginBinding,
} from '../app-build-watch.runner';

/**
 * APW-05 T20 — the `app-build-watch` runner (plan §7.3, §7.1, §4.8, §4.10).
 *
 * ## Why the REAL `AppBuildsService` is in this harness
 *
 * §7.3's transitions are not this job's to write: the row mapping, the two
 * conditional claims, the deployable verdict of §5.1, the receipt and the
 * terminal event belong to T17's `applySnapshot` → `finalize` → `publish`. The
 * properties T20's test line names — the ordered `queued → started → succeeded`
 * sequence published once each, "finalises exactly once across 3 deliveries",
 * `deployable`/`imageDigest` in the payload, `staleInputs` when a sync outran the
 * run — are therefore properties of the pair, and a fake service would only test
 * the fake. So the service is the real class and every collaborator below it is a
 * hand-built fake over an in-memory `work_builds` table.
 *
 * The three seams that make the table honest:
 *
 * - `rows` mimics the query-builder claims the runner and the service issue
 *   (`startedAt IS NULL`, `(status NOT IN (:...terminal) OR completedAt IS NULL)`,
 *   the bare `id = :id` of the lease release and the secret cleanup) and APPLIES
 *   the patch to the stored row. The claims ARE the exactly-once mechanism, so a
 *   fake that ignored them would make the "once across 3 deliveries" case pass
 *   for the wrong reason.
 * - `builds.claimWatchLease` implements the SQL of §7.3:1386-1388
 *   (`watchLeaseUntil IS NULL OR watchLeaseUntil < :now`) against the same table
 *   and RECORDS the lease length it was asked for, so "the lease prevents a
 *   second concurrent observation" is an assertion about the row and about
 *   `2 minutes`, not about a mock's argument list.
 * - `emitted`, `activity`, `usage` and `provisions` record what the ONE writer of
 *   §7.8 did, so "once each", "in this order" and "the flag is in the payload"
 *   are assertions rather than claims.
 *
 * `seed()` stands in for a Build's insert: §7.8:1562-1564 makes the insert one of
 * the three places that publish `app.build.queued`, so the sequence this file
 * asserts starts with the event the insert publishes.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const BUILD_ID = '33333333-3333-4333-8333-333333333333';
const SHA = 'a'.repeat(40);
const TRACKED = 'main';
const FULL_NAME = 'acme/shop';
const PLUGIN_ID = 'github-actions-build';
const IMAGE = 'ghcr.io/acme/shop/ever-works-app';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const TAGS = [`sha-${SHA}`, `branch-${TRACKED}`];

const BUILD_VALUES = [{ name: 'DATABASE_URL', fingerprint: 'v3' }];
const PREPARED_HASH = computeBuildInputsHash(BUILD_VALUES);
/** A different sync of the same names — what a rotation between two runs produces. */
const ROTATED_VALUES = [{ name: 'DATABASE_URL', fingerprint: 'v9' }];
const ROTATED_HASH = computeBuildInputsHash(ROTATED_VALUES);

const SYNCED_AT = new Date('2026-09-17T10:00:30.000Z');
const STARTED_AT = '2026-09-17T10:05:00.000Z';
const COMPLETED_AT = '2026-09-17T10:09:00.000Z';

/** The App spec the verdict reads `valid` from (§5.1's `specValidAtCommit`). */
const SPEC: AppSpec = {
    kind: 'app',
    appSpecVersion: 1,
    display: { name: 'Shop' },
    build: {
        strategy: 'dockerfile',
        dockerfile: 'Dockerfile',
        context: '.',
        resources: { cpu: 2, memory: '2Gi', timeoutMinutes: 60 },
    },
    components: [{ name: 'web', role: 'web', port: 3000 }],
} as AppSpec;

/* -------------------------------------------------------------------------- *
 * The in-memory table
 * -------------------------------------------------------------------------- */

function makeRow(overrides: Partial<WorkBuild> & { id: string }): WorkBuild {
    return {
        number: 1,
        workId: WORK_ID,
        buildPluginId: PLUGIN_ID,
        status: 'queued',
        trigger: 'push',
        branch: TRACKED,
        commitSha: SHA,
        runAttempt: 1,
        digestConfirmed: false,
        deployable: false,
        notDeployableReason: null,
        syncOrigin: 'none',
        queuedAt: new Date('2026-09-17T10:00:00.000Z'),
        createdAt: new Date('2026-09-17T10:00:00.000Z'),
        updatedAt: new Date('2026-09-17T10:00:00.000Z'),
        ...overrides,
    } as WorkBuild;
}

function preparationRow(overrides: Partial<WorkBuildPreparation> = {}): WorkBuildPreparation {
    return {
        id: 'prep-1',
        workId: WORK_ID,
        buildPluginId: PLUGIN_ID,
        workflowState: 'committed',
        webhookState: 'none',
        prepareSeq: 0,
        buildInputsHash: PREPARED_HASH,
        buildSecretNames: ['EW_DATABASE_URL'],
        secretsSyncedAt: SYNCED_AT,
        createdAt: new Date('2026-09-17T09:59:00.000Z'),
        updatedAt: new Date('2026-09-17T09:59:00.000Z'),
        ...overrides,
    } as WorkBuildPreparation;
}

/**
 * The entity repository's conditional-update chain, applied to the stored rows.
 *
 * The two predicates are matched by their own SQL text, so a change to a claim
 * shows up here as a failing assertion rather than as a silently permissive fake.
 */
function rowsRepository(store: Map<string, WorkBuild>): Repository<WorkBuild> {
    return {
        async findOne({ where }: { where: { id: string } }) {
            // A fresh instance, as a real `findOne` returns: a caller's earlier
            // read must not be rewritten under it by a later UPDATE. The runner's
            // `before` is exactly such a read.
            const row = store.get(where.id);
            return row ? ({ ...row } as WorkBuild) : null;
        },
        merge(target: WorkBuild, patch: Partial<WorkBuild>) {
            Object.assign(target, patch);
            return target;
        },
        async save(row: WorkBuild) {
            store.set(row.id, row);
            return row;
        },
        createQueryBuilder() {
            const state: {
                set: Partial<WorkBuild> | null;
                wheres: Array<{ sql: string; params: Record<string, unknown> }>;
            } = { set: null, wheres: [] };
            const builder = {
                update: () => builder,
                set: (patch: Partial<WorkBuild>) => {
                    state.set = patch;
                    return builder;
                },
                where: (sql: string, params: Record<string, unknown>) => {
                    state.wheres.push({ sql, params });
                    return builder;
                },
                andWhere: (sql: string, params: Record<string, unknown>) => {
                    state.wheres.push({ sql, params });
                    return builder;
                },
                async execute() {
                    const id = state.wheres.find((w) => w.sql === 'id = :id')?.params?.id;
                    const row = typeof id === 'string' ? store.get(id) : undefined;
                    if (!row || !state.set) return { affected: 0 };

                    for (const { sql, params } of state.wheres) {
                        // `… WHERE id = :id AND "startedAt" IS NULL`
                        if (sql === 'startedAt IS NULL') {
                            if (row.startedAt) return { affected: 0 };
                            continue;
                        }
                        // `… WHERE id = :id AND (status NOT IN (:...terminal) OR "completedAt" IS NULL)`
                        //
                        // The predicate is EVALUATED from the text it was given, arm by
                        // arm, and not assumed: it holds when EITHER arm does, so the
                        // clock arm's own text decides whether a terminal row is claimed
                        // (`IS NULL` — the owner's cancel, ACC-05-09 — or `IS NOT NULL`,
                        // which is what a mutant writes). A shape neither arm models is
                        // refused LOUDLY: a fake that quietly kept enforcing the original
                        // predicate would let an exactly-once mutant pass for the wrong
                        // reason.
                        if (sql.includes('status NOT IN')) {
                            const inTerminal = (params.terminal as string[]).includes(row.status);
                            const nullArm = sql.includes('completedAt IS NULL');
                            const setArm = sql.includes('completedAt IS NOT NULL');
                            if (!nullArm && !setArm) {
                                throw new Error(
                                    `rowsRepository: the terminal claim's predicate cannot be modelled: ${sql}`,
                                );
                            }
                            const clockArm = nullArm ? !row.completedAt : Boolean(row.completedAt);
                            if (!inTerminal || clockArm) {
                                continue;
                            }
                            return { affected: 0 };
                        }
                        if (sql !== 'id = :id') {
                            throw new Error(`rowsRepository: unrecognised claim predicate: ${sql}`);
                        }
                    }

                    Object.assign(row, state.set);
                    return { affected: 1 };
                },
            };
            return builder;
        },
    } as unknown as Repository<WorkBuild>;
}

/* -------------------------------------------------------------------------- *
 * Snapshots
 * -------------------------------------------------------------------------- */

function runningSnapshot(overrides: Partial<BuildSnapshot> = {}): BuildSnapshot {
    return {
        providerRunId: 'run-77',
        runAttempt: 1,
        status: 'running',
        trigger: 'push',
        branch: TRACKED,
        commitSha: SHA,
        startedAt: STARTED_AT,
        ...overrides,
    } as BuildSnapshot;
}

/** A `succeeded` push run of the tracked branch with ACC-05-07's tags. */
function succeededSnapshot(overrides: Partial<BuildSnapshot> = {}): BuildSnapshot {
    return runningSnapshot({
        status: 'succeeded',
        completedAt: COMPLETED_AT,
        billableMinutes: 4,
        checksBillableMinutes: 1,
        runnerLabel: 'ubuntu-latest',
        image: { repository: IMAGE, digest: DIGEST, tags: [...TAGS], confirmed: true },
        secretCheck: 'passed',
        ...overrides,
    }) as BuildSnapshot;
}

/* -------------------------------------------------------------------------- *
 * The harness
 * -------------------------------------------------------------------------- */

interface Harness {
    readonly runner: AppBuildWatchRunner;
    readonly service: AppBuildsService;
    readonly store: Map<string, WorkBuild>;
    readonly emitted: Array<{ name: string; payload: AppBuildEventPayload }>;
    readonly activity: CreateActivityLogDto[];
    readonly usage: RecordPluginUsageInput[];
    readonly provisions: string[];
    readonly getBuild: jest.Mock;
    readonly deleteVerify: jest.Mock;
    readonly resolvePlugin: jest.Mock;
    readonly redactor: jest.Mock;
    readonly fingerprints: { read: jest.Mock };
    readonly works: { read: jest.Mock };
    /** Every `claimWatchLease` argument list, in order. */
    readonly leaseCalls: Array<{ id: string; leaseMs: number }>;
    readonly binding: AppBuildWatchPluginBinding;
    /** Install the preparation row §7.3's re-stamp reads (§3.1b). */
    setPreparation(patch: Partial<WorkBuildPreparation> | null): void;
    /** Insert one Build and publish its `app.build.queued`, as §7.8:1562 makes the insert do. */
    seed(row: WorkBuild): Promise<WorkBuild>;
    row(id: string): WorkBuild;
    events(): string[];
    payloads(event: string): AppBuildEventPayload[];
}

interface HarnessOptions {
    /** The App Work's tracked branch — §5.1's `branch == trackedBranch` clause. */
    readonly trackedBranch?: string;
    /** `null` makes APW-07's fingerprint reader answer "cannot answer". */
    readonly fingerprints?: Record<string, string> | null;
    /** The App spec's verdict at this commit; `false` is §5.1's `specInvalid`. */
    readonly specValid?: boolean;
    /** Let the provisional APW-04 port throw, for `APW05-G11`. */
    readonly provisionThrows?: boolean;
}

function makeHarness(options: HarnessOptions = {}): Harness {
    const store = new Map<string, WorkBuild>();
    const emitted: Harness['emitted'] = [];
    const activity: CreateActivityLogDto[] = [];
    const usage: RecordPluginUsageInput[] = [];
    const provisions: string[] = [];
    const leaseCalls: Harness['leaseCalls'] = [];
    let preparation: WorkBuildPreparation | null = preparationRow();

    const context: AppBuildWorkContext = {
        workId: WORK_ID,
        userId: USER_ID,
        trackedBranch: options.trackedBranch ?? TRACKED,
        buildPluginId: PLUGIN_ID,
        repositoryFullName: FULL_NAME,
        repositoryVisibility: 'public',
    };

    const getBuild = jest.fn(async (): Promise<BuildSnapshot | null> => succeededSnapshot());
    const deleteVerify = jest.fn(async () => ({ deleted: true }));

    const binding = {
        pluginId: PLUGIN_ID,
        buildKind: 'github-actions',
        imageRepository: IMAGE,
        repository: {
            owner: 'acme',
            repo: 'shop',
            visibility: 'public',
            trackedBranch: TRACKED,
            createdByAppWork: true,
        },
        settings: {},
        auth: { token: 'installation-token' },
        getBuild,
        deleteVerifyPromptedSecret: deleteVerify,
    } as unknown as AppBuildWatchPluginBinding;

    const resolvePlugin = jest.fn(async () => binding);
    const redactor = jest.fn(async () => (text: string) => text.replace('SECRET', '***'));

    const builds = {
        claimWatchLease: jest.fn(async (id: string, leaseMs: number) => {
            leaseCalls.push({ id, leaseMs });
            const row = store.get(id);
            if (!row) return false;
            const now = Date.now();
            const until = row.watchLeaseUntil ? new Date(row.watchLeaseUntil).getTime() : null;
            // `WHERE id = :id AND (watchLeaseUntil IS NULL OR watchLeaseUntil < :now)`
            if (until !== null && until > now) return false;
            row.watchLeaseUntil = new Date(now + Math.max(0, leaseMs));
            return true;
        }),
    } as unknown as AppBuildRepository;

    const preparations = {
        findByWork: jest.fn(async () => preparation),
        upsertAfterPrepare: jest.fn(async () => preparation),
    } as unknown as AppBuildPreparationRepository;

    const activityLog = {
        log: jest.fn(async (dto: CreateActivityLogDto) => {
            activity.push(dto);
            return { id: `activity-${activity.length}` };
        }),
    } as unknown as ActivityLogService;

    const emitter = {
        emit: jest.fn((name: string, event: { payload: AppBuildEventPayload }) => {
            emitted.push({ name, payload: event.payload });
            return true;
        }),
    } as unknown as EventEmitter2;

    const usageService = {
        record: jest.fn(async (input: RecordPluginUsageInput) => {
            usage.push(input);
            return { id: `usage-${usage.length}` };
        }),
    } as unknown as PluginUsageService;

    const fingerprints = {
        read: jest.fn(async () =>
            options.fingerprints === undefined ? { DATABASE_URL: 'v3' } : options.fingerprints,
        ),
    };

    const works = { read: jest.fn(async () => context) };

    const specs = {
        read: jest.fn(
            async (): Promise<AppBuildSpecRead> => ({
                spec: SPEC,
                commitSha: SHA,
                specHash: 'f'.repeat(64),
                valid: options.specValid ?? true,
            }),
        ),
    };

    const provisionEvents = {
        buildUpdated: jest.fn(async (buildId: string) => {
            provisions.push(buildId);
            if (options.provisionThrows) {
                // APW-04's handler failing is the case §7.8:1578-1580 names.
                throw new Error('provisioner unavailable');
            }
        }),
    };

    const env = { buildRedactor: redactor } as unknown as AppEnvService;

    const service = new AppBuildsService(
        builds,
        preparations,
        rowsRepository(store),
        activityLog,
        emitter,
        usageService,
        fingerprints as never,
        provisionEvents as never,
        { resolve: resolvePlugin } as never,
        works as never,
        specs as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
    );

    const runner = new AppBuildWatchRunner(
        builds,
        preparations,
        service,
        { resolve: resolvePlugin } as never,
        works as never,
        env,
        rowsRepository(store),
    );

    return {
        runner,
        service,
        store,
        emitted,
        activity,
        usage,
        provisions,
        getBuild,
        deleteVerify,
        resolvePlugin,
        redactor,
        fingerprints,
        works,
        leaseCalls,
        binding,
        setPreparation: (patch) => {
            preparation = patch === null ? null : preparationRow(patch);
        },
        seed: async (row) => {
            store.set(row.id, row);
            // §7.8:1562-1564 — the insert is one of the three places that publish
            // `app.build.queued`, once. Seeding IS the insert in this table, so a
            // row seeded as `queued` publishes it; a row seeded in another status
            // (a Build the owner cancelled between two observations, say) is one
            // whose `queued` belongs to an earlier life this table does not replay
            // — and §7.8's map would refuse the event for that status anyway.
            if (row.status === 'queued') {
                await service.publish(row, 'app.build.queued');
            }
            return row;
        },
        row: (id) => {
            const row = store.get(id);
            if (!row) throw new Error(`no row ${id}`);
            return row;
        },
        events: () => emitted.map((entry) => entry.name),
        payloads: (event) =>
            emitted.filter((entry) => entry.name === event).map((entry) => entry.payload),
    };
}

/** A stable uuid-shaped id, so a test never has to spell one out. */
function uuid(index: number): string {
    return `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

/** Poll until `check()` is true, so an unawaited run can be observed. */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('waitFor: the condition never became true');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** One `app-build-watch` payload (§7.1). */
function payload(buildId = BUILD_ID, reason = 'event') {
    return { buildId, reason } as never;
}

/* -------------------------------------------------------------------------- *
 * The pure helpers and the pinned numbers
 * -------------------------------------------------------------------------- */

describe('the job’s own contract (§7.1, §7.3)', () => {
    it('pins the id the dispatcher enqueues under, and the lease and cap the plan states', () => {
        expect(APP_BUILD_WATCH_JOB_ID).toBe('app-build-watch');
        // T18's `app-build-watch.types.ts` is what `trigger.service.ts:1234`
        // enqueues under; the two must be the same string.
        expect(AGENT_WATCH_TASK_ID).toBe(APP_BUILD_WATCH_JOB_ID);
        // §7.3:1387-1388 — `:until = :now + 2 minutes`.
        expect(APP_BUILD_WATCH_LEASE_MS).toBe(120_000);
        // §7.1:1329-1330 — ten in-process runs per API process.
        expect(APP_BUILD_WATCH_MAX_CONCURRENT_RUNS).toBe(10);
        expect(APP_BUILD_WATCH_SKIP_REASONS).toHaveLength(9);
    });

    it('registers the same id in the Trigger task module T20 ships', () => {
        const source = readFileSync(
            join(
                __dirname,
                '..',
                '..',
                '..',
                '..',
                'tasks',
                'src',
                'tasks',
                'trigger',
                'app-build-watch.task.ts',
            ),
            'utf8',
        );

        // The registration uses the constant, and the constant is the id the
        // dispatcher enqueues under — `task({ id: APP_BUILD_WATCH_TASK_ID, … })`.
        expect(source).toContain(
            "export const APP_BUILD_WATCH_TASK_ID = 'app-build-watch' as const;",
        );
        expect(source).toContain('id: APP_BUILD_WATCH_TASK_ID,');
        expect(source).toContain("task<'app-build-watch', AppBuildWatchTaskPayload>");
    });

    it('splits a repository full name into its two coordinates', () => {
        expect(repositoryCoordinates('acme/shop')).toEqual({ owner: 'acme', repo: 'shop' });
        expect(repositoryCoordinates('unsplittable')).toEqual({ owner: 'unsplittable', repo: '' });
    });
});

/* -------------------------------------------------------------------------- *
 * The lease (§7.3:1386-1388)
 * -------------------------------------------------------------------------- */

describe('the watch lease (§7.3)', () => {
    it('refuses a second concurrent observation of the same Build and never calls the provider twice', async () => {
        const harness = makeHarness();
        await harness.seed(makeRow({ id: BUILD_ID }));

        // The FIRST provider call stays open until this test lets it finish, which
        // is what makes the second dispatch genuinely concurrent. Every later call
        // answers at once, so a runner that ignored the lease would say so by
        // RETURNING an observation rather than by hanging this test.
        const gates: Array<() => void> = [];
        let calls = 0;
        harness.getBuild.mockImplementation(async () => {
            calls += 1;
            if (calls > 1) {
                return succeededSnapshot();
            }
            return new Promise<BuildSnapshot>((resolve) => {
                gates.push(() => resolve(succeededSnapshot()));
            });
        });

        const first = harness.runner.run(payload(BUILD_ID, 'event'));
        await waitFor(() => gates.length === 1);

        const second = await harness.runner.run(payload(BUILD_ID, 'sweep'));

        expect(second).toMatchObject({ status: 'skipped', reason: 'leaseHeld', buildId: BUILD_ID });
        expect(harness.getBuild).toHaveBeenCalledTimes(1);
        expect(harness.leaseCalls).toEqual([
            { id: BUILD_ID, leaseMs: 120_000 },
            { id: BUILD_ID, leaseMs: 120_000 },
        ]);

        for (const release of gates) release();
        await expect(first).resolves.toMatchObject({ status: 'observed' });
        // The winner released the lease on its way out, so the next delivery is
        // observed rather than refused by a lease nobody holds.
        expect(harness.row(BUILD_ID).watchLeaseUntil ?? null).toBeNull();
    });

    it('answers `buildUnavailable` for a row that is gone, and takes no lease', async () => {
        const harness = makeHarness();

        const result = await harness.runner.run(payload('44444444-4444-4444-8444-444444444444'));

        expect(result).toMatchObject({ status: 'skipped', reason: 'buildUnavailable' });
        expect(harness.leaseCalls).toHaveLength(0);
        expect(harness.getBuild).not.toHaveBeenCalled();
    });

    it('refuses a payload with no Build id before it touches anything', async () => {
        const harness = makeHarness();

        const result = await harness.runner.run({ reason: 'event' } as never);

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'invalidPayload',
            buildId: null,
            jobId: APP_BUILD_WATCH_JOB_ID,
        });
        expect(harness.leaseCalls).toHaveLength(0);
    });
});

/* -------------------------------------------------------------------------- *
 * The observation and its fail-closed skips (§7.3, FR-38)
 * -------------------------------------------------------------------------- */

describe('the observation (§7.3)', () => {
    it('redacts through APW-07 when the binding carries no redactor of its own', async () => {
        const harness = makeHarness();
        await harness.seed(makeRow({ id: BUILD_ID }));
        delete (harness.binding as { redact?: unknown }).redact;

        await harness.runner.run(payload());

        expect(harness.redactor).toHaveBeenCalledWith(WORK_ID);
        const redact = harness.getBuild.mock.calls[0][2] as (text: string) => string;
        expect(redact('value SECRET here')).toBe('value *** here');
    });

    it('never asks APW-07 for a redactor the binding already carries', async () => {
        const harness = makeHarness();
        await harness.seed(makeRow({ id: BUILD_ID }));
        const own = (text: string) => text.replace('SECRET', '<own>');
        (harness.binding as { redact?: unknown }).redact = own;

        await harness.runner.run(payload());

        expect(harness.getBuild.mock.calls[0][2]).toBe(own);
        expect(harness.redactor).not.toHaveBeenCalled();
    });

    it('passes the Build, its run identity and the Work’s coordinates to `getBuild`', async () => {
        const harness = makeHarness();
        const row = await harness.seed(
            makeRow({
                id: BUILD_ID,
                providerRunId: 'run-91',
                dispatchedAt: new Date('2026-09-17T10:04:00.000Z'),
            }),
        );

        await harness.runner.run(payload());

        const ref = harness.getBuild.mock.calls[0][0] as {
            buildId: string;
            providerRunId: string | null;
            dispatchedAt?: string;
            repository: { owner: string; repo: string; trackedBranch: string };
        };
        expect(ref).toMatchObject({
            buildId: row.id,
            providerRunId: 'run-91',
            dispatchedAt: '2026-09-17T10:04:00.000Z',
            repository: { owner: 'acme', repo: 'shop', trackedBranch: TRACKED },
        });
        expect(harness.getBuild.mock.calls[0][1]).toEqual({ token: 'installation-token' });
    });

    it.each([
        ['workUnavailable', (harness: Harness) => harness.works.read.mockResolvedValue(null)],
        ['pluginUnavailable', (harness: Harness) => harness.resolvePlugin.mockResolvedValue(null)],
        [
            'pluginUnavailable',
            (harness: Harness) => delete (harness.binding as { getBuild?: unknown }).getBuild,
        ],
        [
            'authUnavailable',
            (harness: Harness) => delete (harness.binding as { auth?: unknown }).auth,
        ],
        [
            'redactorUnavailable',
            (harness: Harness) =>
                harness.redactor.mockRejectedValue(new Error('no secure storage')),
        ],
        ['snapshotUnavailable', (harness: Harness) => harness.getBuild.mockResolvedValue(null)],
    ])(
        'answers `%s` without writing a row, publishing an event or calling the provisioner',
        async (reason, breakIt) => {
            const harness = makeHarness();
            await harness.seed(makeRow({ id: BUILD_ID }));
            breakIt(harness);

            const result = await harness.runner.run(payload());

            expect(result).toMatchObject({ status: 'skipped', reason, observedStatus: null });
            expect(harness.events()).toEqual(['app.build.queued']);
            expect(harness.provisions).toHaveLength(0);
            expect(harness.row(BUILD_ID)).toMatchObject({
                status: 'queued',
                deployable: false,
                notDeployableReason: null,
            });
            expect(harness.row(BUILD_ID).lastObservedAt ?? null).toBeNull();
        },
    );
});

/* -------------------------------------------------------------------------- *
 * The re-stamp and the verdict (§7.3:1389-1391, §5.1, ACC-05-07, APW05-G03)
 * -------------------------------------------------------------------------- */

describe('the preparation re-stamp (§7.3, APW05-G03)', () => {
    it('stamps the values the run read, and the Build is deployable with ACC-05-07’s tags', async () => {
        const harness = makeHarness();
        // The consumer's insert copied the stamps it saw (§7.5); the preparation
        // row has since moved to the values this run actually read.
        await harness.seed(
            makeRow({
                id: BUILD_ID,
                buildInputsHash: computeBuildInputsHash([
                    { name: 'DATABASE_URL', fingerprint: 'v2' },
                ]),
                buildSecretNames: ['EW_DATABASE_URL'],
                secretsSyncedAt: new Date('2026-09-17T09:50:00.000Z'),
            }),
        );
        harness.setPreparation({
            buildInputsHash: PREPARED_HASH,
            buildSecretNames: ['EW_DATABASE_URL'],
            secretsSyncedAt: SYNCED_AT,
        });
        harness.getBuild.mockResolvedValue(succeededSnapshot());

        const result = await harness.runner.run(payload());

        expect(result).toMatchObject({
            status: 'observed',
            observedStatus: 'succeeded',
            started: true,
            restamped: true,
            finalised: true,
            deployable: true,
            notDeployableReason: null,
        });
        const row = harness.row(BUILD_ID);
        expect(row.buildInputsHash).toBe(PREPARED_HASH);
        expect(row.secretsSyncedAt).toEqual(SYNCED_AT);
        expect(row.buildSecretNames).toEqual(['EW_DATABASE_URL']);
        // ACC-05-07 — the confirmed digest and the two tags, and never `latest`.
        expect(row).toMatchObject({
            status: 'succeeded',
            imageRepository: IMAGE,
            imageDigest: DIGEST,
            digestConfirmed: true,
        });
        expect(row.imageTags).toEqual(TAGS);
        expect(row.imageTags).not.toContain('latest');
        expect(harness.payloads('app.build.succeeded')[0]).toMatchObject({
            branch: TRACKED,
            trigger: 'push',
            deployable: true,
            notDeployableReason: null,
            imageDigest: DIGEST,
        });
    });

    it('never stamps a preparation that synced AFTER the run started, and the Build is staleInputs', async () => {
        const harness = makeHarness();
        await harness.seed(
            makeRow({
                id: BUILD_ID,
                buildInputsHash: PREPARED_HASH,
                buildSecretNames: ['EW_DATABASE_URL'],
                secretsSyncedAt: SYNCED_AT,
            }),
        );
        // A rotation that landed after `startedAt` — §5.1's S24 case.
        harness.setPreparation({
            buildInputsHash: ROTATED_HASH,
            buildSecretNames: ['EW_DATABASE_URL', 'EW_APP_SECRET'],
            secretsSyncedAt: new Date('2026-09-17T10:06:00.000Z'),
        });
        harness.fingerprints.read.mockResolvedValue({ DATABASE_URL: 'v9' });

        const result = await harness.runner.run(payload());

        expect(result).toMatchObject({
            status: 'observed',
            restamped: false,
            finalised: true,
            deployable: false,
            notDeployableReason: 'staleInputs',
        });
        // The row kept what the run read: the newer sync is NOT copied onto it.
        expect(harness.row(BUILD_ID).buildInputsHash).toBe(PREPARED_HASH);
        expect(harness.row(BUILD_ID).secretsSyncedAt).toEqual(SYNCED_AT);
        expect(harness.row(BUILD_ID).buildSecretNames).toEqual(['EW_DATABASE_URL']);
        expect(harness.payloads('app.build.succeeded')[0]).toMatchObject({
            deployable: false,
            notDeployableReason: 'staleInputs',
        });
    });

    it('leaves the stamps alone when a later observation re-reads a started Build', async () => {
        const harness = makeHarness();
        harness.getBuild.mockResolvedValue(runningSnapshot());
        await harness.seed(makeRow({ id: BUILD_ID }));

        const first = await harness.runner.run(payload());
        expect(first).toMatchObject({ restamped: true, started: true });

        // The sync moved again, and this Build already recorded its first start.
        harness.setPreparation({
            buildInputsHash: ROTATED_HASH,
            secretsSyncedAt: new Date('2026-09-17T11:00:00.000Z'),
        });
        const second = await harness.runner.run(payload());

        expect(second).toMatchObject({ restamped: false, started: false });
        expect(harness.row(BUILD_ID).buildInputsHash).toBe(PREPARED_HASH);
        expect(harness.row(BUILD_ID).secretsSyncedAt).toEqual(SYNCED_AT);
    });
});

/* -------------------------------------------------------------------------- *
 * The events and the one finalisation (§7.8, APW05-G05)
 * -------------------------------------------------------------------------- */

describe('the status → event map (§7.8, APW05-G05)', () => {
    it('publishes queued → started → succeeded once each, in that order', async () => {
        const harness = makeHarness();
        await harness.seed(makeRow({ id: BUILD_ID }));

        harness.getBuild.mockResolvedValue(runningSnapshot());
        const running = await harness.runner.run(payload(BUILD_ID, 'event'));
        expect(running).toMatchObject({ status: 'observed', started: true, finalised: false });

        harness.getBuild.mockResolvedValue(succeededSnapshot());
        const succeeded = await harness.runner.run(payload(BUILD_ID, 'event'));

        expect(harness.events()).toEqual([
            'app.build.queued',
            'app.build.started',
            'app.build.succeeded',
        ]);
        expect(harness.payloads('app.build.queued')).toHaveLength(1);
        expect(harness.payloads('app.build.started')).toHaveLength(1);
        expect(harness.payloads('app.build.succeeded')).toHaveLength(1);
        expect(succeeded).toMatchObject({ finalised: true, deployable: true });
        // One Activity row per event, `action` = the event name (R-2).
        expect(harness.activity.map((row) => row.action)).toEqual([
            'app.build.queued',
            'app.build.started',
            'app.build.succeeded',
        ]);
        expect(harness.activity.every((row) => row.actionType === 'app_build')).toBe(true);
    });

    it('still publishes started before succeeded when the first snapshot is already completed', async () => {
        const harness = makeHarness();
        await harness.seed(makeRow({ id: BUILD_ID }));
        harness.getBuild.mockResolvedValue(succeededSnapshot());

        const result = await harness.runner.run(payload());

        expect(result).toMatchObject({ started: true, finalised: true });
        expect(harness.events()).toEqual([
            'app.build.queued',
            'app.build.started',
            'app.build.succeeded',
        ]);
        expect(harness.row(BUILD_ID).startedAt).toEqual(new Date(STARTED_AT));
    });

    it('emits `app.build.succeeded` only with the computed flag — false when the digest is unconfirmed', async () => {
        const harness = makeHarness();
        await harness.seed(makeRow({ id: BUILD_ID }));
        harness.getBuild.mockResolvedValue(
            succeededSnapshot({
                image: { repository: IMAGE, digest: DIGEST, tags: [...TAGS], confirmed: false },
            }),
        );

        const result = await harness.runner.run(payload());

        expect(result).toMatchObject({
            finalised: true,
            deployable: false,
            notDeployableReason: 'digestUnconfirmed',
        });
        expect(harness.payloads('app.build.succeeded')[0]).toMatchObject({
            deployable: false,
            notDeployableReason: 'digestUnconfirmed',
            imageDigest: DIGEST,
        });
    });

    it('finalises exactly once across three deliveries of the same terminal snapshot', async () => {
        const harness = makeHarness();
        await harness.seed(makeRow({ id: BUILD_ID }));
        harness.getBuild.mockResolvedValue(succeededSnapshot());

        const first = await harness.runner.run(payload(BUILD_ID, 'event'));
        const second = await harness.runner.run(payload(BUILD_ID, 'sweep'));
        const third = await harness.runner.run(payload(BUILD_ID, 'dispatched'));

        expect([first.finalised, second.finalised, third.finalised]).toEqual([true, false, false]);
        expect(harness.payloads('app.build.succeeded')).toHaveLength(1);
        expect(harness.payloads('app.build.started')).toHaveLength(1);
        expect(harness.activity.filter((row) => row.action === 'app.build.succeeded')).toHaveLength(
            1,
        );
        expect(harness.usage).toHaveLength(1);
        expect(harness.row(BUILD_ID).completedAt).toEqual(new Date(COMPLETED_AT));
    });

    it('finalises a Build the owner cancelled, whose clock the cancel left NULL (ACC-05-09)', async () => {
        const harness = makeHarness();
        await harness.seed(
            makeRow({
                id: BUILD_ID,
                status: 'cancelled',
                cancelReason: 'user',
                startedAt: new Date(STARTED_AT),
                completedAt: null,
            }),
        );
        harness.getBuild.mockResolvedValue(
            runningSnapshot({ status: 'cancelled', startedAt: undefined }),
        );

        const result = await harness.runner.run(payload());

        expect(result).toMatchObject({ finalised: true, deployable: false });
        // No `started` is invented for a run that never reported one, and the
        // cancel's own event is the only one the observation publishes.
        expect(harness.events()).toEqual(['app.build.cancelled']);
        expect(harness.row(BUILD_ID).completedAt).toBeTruthy();
    });
});

/* -------------------------------------------------------------------------- *
 * The verification Build (§4.10, APW05-G11, ACC-05-23)
 * -------------------------------------------------------------------------- */

describe('a verification Build (§4.10, APW05-G11)', () => {
    function verificationRow(overrides: Partial<WorkBuild> = {}): WorkBuild {
        return makeRow({
            id: BUILD_ID,
            trigger: 'verification',
            branch: 'refs/heads/proposal',
            verifySecretNames: [APP_BUILD_VERIFY_PROMPTED_SECRET],
            ...overrides,
        });
    }

    it('calls buildUpdated for queued, started and the terminal transition — three times', async () => {
        const harness = makeHarness();
        await harness.seed(verificationRow());

        harness.getBuild.mockResolvedValue(runningSnapshot({ trigger: 'verification' }));
        await harness.runner.run(payload(BUILD_ID, 'dispatched'));

        harness.getBuild.mockResolvedValue(
            succeededSnapshot({ trigger: 'verification', branch: 'refs/heads/proposal' }),
        );
        await harness.runner.run(payload(BUILD_ID, 'event'));

        // queued (the insert), running (the first observation) and succeeded.
        expect(harness.provisions).toEqual([BUILD_ID, BUILD_ID, BUILD_ID]);
    });

    it('deletes the per-run prompted-value secret on the terminal transition, once', async () => {
        const harness = makeHarness();
        await harness.seed(verificationRow());
        harness.getBuild.mockResolvedValue(
            succeededSnapshot({ trigger: 'verification', branch: 'refs/heads/proposal' }),
        );

        const first = await harness.runner.run(payload(BUILD_ID, 'event'));
        const second = await harness.runner.run(payload(BUILD_ID, 'sweep'));

        expect(first.verifySecretsRemoved).toBe(1);
        expect(second.verifySecretsRemoved).toBe(0);
        expect(harness.deleteVerify).toHaveBeenCalledTimes(1);
        // The record is cleared, so §7.4's orphan pass does not delete it again.
        expect(harness.row(BUILD_ID).verifySecretNames).toEqual([]);
    });

    it('keeps the secret for the sweep when the plugin cannot delete it, and still finalises', async () => {
        const harness = makeHarness();
        await harness.seed(verificationRow());
        delete (harness.binding as { deleteVerifyPromptedSecret?: unknown })
            .deleteVerifyPromptedSecret;
        harness.getBuild.mockResolvedValue(
            succeededSnapshot({ trigger: 'verification', branch: 'refs/heads/proposal' }),
        );

        const result = await harness.runner.run(payload());

        expect(result).toMatchObject({
            status: 'observed',
            finalised: true,
            verifySecretsRemoved: 0,
        });
        expect(harness.row(BUILD_ID).verifySecretNames).toEqual([APP_BUILD_VERIFY_PROMPTED_SECRET]);
    });

    it('survives a throwing provisioner port and a throwing secret deletion', async () => {
        const harness = makeHarness({ provisionThrows: true });
        await harness.seed(verificationRow());
        harness.deleteVerify.mockRejectedValue(new Error('the secret is gone already'));
        harness.getBuild.mockResolvedValue(
            succeededSnapshot({ trigger: 'verification', branch: 'refs/heads/proposal' }),
        );

        const result = await harness.runner.run(payload());

        expect(result).toMatchObject({
            status: 'observed',
            finalised: true,
            verifySecretsRemoved: 0,
            deployable: false,
            notDeployableReason: 'verification',
        });
        expect(harness.payloads('app.build.succeeded')).toHaveLength(1);
    });
});

/* -------------------------------------------------------------------------- *
 * §7.1's in-process cap (APW05-G20)
 * -------------------------------------------------------------------------- */

describe('the in-process cap of §7.1', () => {
    it('runs ten at a time and refuses the eleventh by name, leaving it to the sweep', async () => {
        const harness = makeHarness();
        const ids = Array.from({ length: APP_BUILD_WATCH_MAX_CONCURRENT_RUNS + 1 }, (_, index) =>
            uuid(index + 1),
        );
        for (const [index, id] of ids.entries()) {
            await harness.seed(makeRow({ id, number: index + 1 }));
        }

        // Ten calls stay open; anything the runner starts beyond the cap answers at
        // once, so a runner with no cap says so by RETURNING an observation rather
        // than by hanging this test.
        const gates: Array<() => void> = [];
        let held = 0;
        harness.getBuild.mockImplementation(async () => {
            if (held >= APP_BUILD_WATCH_MAX_CONCURRENT_RUNS) {
                return succeededSnapshot();
            }
            held += 1;
            return new Promise<BuildSnapshot>((resolve) => {
                gates.push(() => resolve(succeededSnapshot()));
            });
        });

        const inFlight = ids
            .slice(0, APP_BUILD_WATCH_MAX_CONCURRENT_RUNS)
            .map((id) => harness.runner.run(payload(id, 'sweep')));
        await waitFor(
            () => harness.getBuild.mock.calls.length === APP_BUILD_WATCH_MAX_CONCURRENT_RUNS,
        );

        const eleventh = await harness.runner.run(payload(ids[10], 'sweep'));

        expect(eleventh).toMatchObject({ status: 'skipped', reason: 'concurrencyLimited' });
        expect(harness.getBuild).toHaveBeenCalledTimes(APP_BUILD_WATCH_MAX_CONCURRENT_RUNS);
        // The excess is deferred, not lost: nothing was written and no lease taken.
        expect(harness.leaseCalls.some((call) => call.id === ids[10])).toBe(false);
        expect(harness.row(ids[10])).toMatchObject({ status: 'queued' });

        for (const release of gates) release();
        await Promise.all(inFlight);

        // A slot freed by a finished run is usable again.
        const again = harness.runner.run(payload(ids[10], 'sweep'));
        await expect(again).resolves.toMatchObject({ status: 'observed' });
    });
});
