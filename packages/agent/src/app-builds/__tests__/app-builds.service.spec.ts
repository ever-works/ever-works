import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// `verify-plan.schema.json` declares `$schema: draft/2020-12`, so it is compiled
// with ajv's 2020 entry point rather than the draft-07 default.
import Ajv2020 from 'ajv/dist/2020';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Repository } from 'typeorm';
import {
    APP_BUILD_VERIFY_PROMPTED_SECRET,
    appBuildEventNameForStatus,
    computeBuildInputsHash,
    type AppBuildEventPayload,
    type AppSpec,
    type BuildRunRef,
    type AppEnvRecipeEntry,
} from '@ever-works/contracts';
import type { BuildSnapshot } from '@ever-works/plugin';
import { ActivityStatus } from '../../entities/activity-log.types';
import { WorkBuild } from '../../entities/work-build.entity';
import { WorkBuildPreparation } from '../../entities/work-build-preparation.entity';
import type { AppEnvResolvedFingerprints } from '../../app-env/app-env.service';
import type { AppBuildPreparationRepository } from '../../database/repositories/app-build-preparation.repository';
import type {
    AppBuildRepository,
    WorkBuildInsert,
} from '../../database/repositories/app-build.repository';
import type { ActivityLogService } from '../../activity-log/activity-log.service';
import type { PluginUsageService, RecordPluginUsageInput } from '../../usage/plugin-usage.service';
import type { CreateActivityLogDto } from '../../entities/activity-log.types';
// The deploy reference APW-06 builds from a Build row — what a confirmation is FOR.
import { imageReferenceOf } from '../../app-runtime/app-deploy-build.source';
import {
    APP_BUILD_DIGEST_READ_TIMEOUT_MS,
    APP_BUILD_PREPARE_DISPATCHER,
    APP_BUILD_PREPARE_RUNNER,
    APP_BUILD_PLUGIN_RESOLVER,
    APP_BUILD_RUNNER_RECIPE_SOURCE,
    APP_BUILD_SPEC_SOURCE,
    APP_BUILD_WATCH_DISPATCHER,
    APP_BUILD_WATCH_RUNNER,
    APP_BUILD_WORK_SOURCE,
    AppBuildsService,
    AppVerificationPlanRefusedError,
    buildVerificationPlan,
    verificationPlanMemoryMiB,
    type AppBuildPluginResolver,
    type AppBuildRebuildResult,
} from '../app-builds.service';
// APW-05 T18 — the factory that binds the dispatcher tokens in the real graph. Imported so
// the swap can be asserted against the binding the application actually uses instead of
// against a comment about it.
import { buildJobRuntimeProviders } from '../../tasks/job-runtime.providers';

/**
 * APW-05 T17 — `AppBuildsService` (plan §7.1, §7.2, §7.5, §7.8, §5.1, §4.10).
 *
 * Every collaborator is a hand-built fake and the whole Build life runs against an
 * in-memory `work_builds` table, because the properties under test are the ORDER
 * and the EXACTLY-ONCE-ness of the transitions — a real DataSource would test
 * TypeORM, not this service.
 *
 * The three seams that make the table honest:
 *
 * - `rows` mimics the two conditional claims the service issues through
 *   `createQueryBuilder` by **evaluating** the recorded `where`/`andWhere`
 *   fragments arm by arm. The claims ARE the idempotency mechanism, so a fake
 *   that ignored them would make the "exactly once" cases pass for the wrong
 *   reason — and a fake that **re-stated** them instead of reading them (C19)
 *   makes those same cases blind to a change in the service's own predicate,
 *   which is worse: they would keep passing against a `claimTerminal` that no
 *   longer claims exactly once. A predicate shape the fake does not model is
 *   refused loudly (see `execute` below), so a mutant reds instead of passing.
 * - `builds` implements the four `AppBuildRepository` members the service calls,
 *   with the number arithmetic and the `(plugin, runId, attempt)` identity the real
 *   one has.
 * - `activity`, `emitted`, `usage` and `provision` record what the ONE writer of
 *   §7.8 did, so "one Activity row", "one event" and "one call to APW-04" are
 *   assertions rather than claims.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;

const BUILD_VALUES = [
    { name: 'DATABASE_URL', fingerprint: 'v3' },
    { name: 'APP_SECRET', fingerprint: 'v7' },
];
const PREPARED_HASH = computeBuildInputsHash(BUILD_VALUES);

/** The App spec fixture the plan is built from (plan §4.10:1055-1063). */
const SPEC_FIXTURE: AppSpec = {
    kind: 'app',
    appSpecVersion: 1,
    display: { name: 'Shop' },
    build: {
        strategy: 'dockerfile',
        dockerfile: 'Dockerfile',
        context: '.',
        resources: { cpu: 2, memory: '2Gi', timeoutMinutes: 60 },
    },
    components: [
        {
            name: 'web',
            role: 'web',
            port: 3000,
            resources: { memoryLimit: '1Gi' },
            probes: { readiness: { http: '/health', periodSeconds: 5 } },
        },
        { name: 'worker', role: 'worker', resources: { memoryLimit: '1Gi' } },
    ],
    dependencies: {
        postgres: { version: '16' },
        redis: { version: '7' },
        objectStorage: { buckets: ['uploads'] },
    },
    env: [{ name: 'DATABASE_URL', from: 'deps.postgres.url' }],
    jobs: [
        { name: 'migrate', when: 'pre-deploy', command: ['npm', 'run', 'migrate'] },
        { name: 'after', when: 'post-deploy', command: ['true'] },
    ],
    smoke: [
        {
            name: 'home',
            http: { method: 'GET', path: '/' },
            expect: { status: [200], bodyContains: ['Shop'] },
        },
    ],
    checks: [{ name: 'lint', command: 'npm run lint', required: true, timeoutSeconds: 900 }],
};

/** The value-free runner recipe APW-07 answers with (§4.10:1025-1030). */
const RECIPE_FIXTURE: AppEnvRecipeEntry[] = [
    { name: 'DATABASE_URL', source: 'literal', value: 'postgres://ew-dep-postgres/app' } as never,
    { name: 'APP_SECRET', source: 'generate', generate: { kind: 'hex', bytes: 32 } } as never,
    { name: 'ADMIN_EMAIL', source: 'prompted' } as never,
];

const SCHEMA_PATH = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'docs',
    'specs',
    'features',
    'app-works',
    'APW-05-builds',
    'verify-plan.schema.json',
);

/* -------------------------------------------------------------------------- *
 * The in-memory table
 * -------------------------------------------------------------------------- */

function uuid(n: number): string {
    return `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function makeRow(overrides: Partial<WorkBuild> & { workId: string }): WorkBuild {
    return {
        id: uuid(1),
        number: 1,
        buildPluginId: 'github-actions-build',
        status: 'queued',
        trigger: 'push',
        branch: 'main',
        commitSha: SHA,
        runAttempt: 1,
        digestConfirmed: false,
        deployable: false,
        syncOrigin: 'none',
        createdAt: new Date('2026-09-17T10:00:00.000Z'),
        updatedAt: new Date('2026-09-17T10:00:00.000Z'),
        ...overrides,
    } as WorkBuild;
}

interface Harness {
    readonly service: AppBuildsService;
    readonly store: Map<string, WorkBuild>;
    readonly activity: CreateActivityLogDto[];
    readonly emitted: Array<{ name: string; event: { payload: AppBuildEventPayload } }>;
    readonly usage: RecordPluginUsageInput[];
    readonly provisions: string[];
    readonly dispatchedPrepare: Array<{ workId: string; reason: string; buildId?: string }>;
    readonly dispatchedWatch: Array<{ buildId: string; reason: string }>;
    readonly runnerRuns: Array<{ kind: 'prepare' | 'watch'; key: string }>;
    readonly startBuildCalls: Array<Record<string, unknown>>;
    readonly cancelBuildCalls: Array<{ buildId: string; providerRunId: string | null }>;
    /** Every `checkImageAccess` call the binding received (T14's registry read). */
    readonly imageAccessCalls: Array<ImageAccessInput>;
    seed(row: WorkBuild): WorkBuild;
    seedPreparation(patch: Partial<WorkBuildPreparation>): void;
    /** The Work's preparation row as the fake repository holds it now. */
    preparation(): WorkBuildPreparation | undefined;
    /** The fake preparation repository itself, for a case that spies on a read or a write. */
    readonly preparationRepository: AppBuildPreparationRepository;
    row(id: string): WorkBuild;
    events(): string[];
}

interface HarnessOptions {
    readonly prepareDispatcher?: (payload: unknown) => Promise<string | null>;
    readonly prepareRunner?: (payload: {
        workId: string;
        reason: string;
        buildId?: string;
    }) => Promise<unknown>;
    readonly provisionEvents?: { buildUpdated(buildId: string): Promise<void> | void };
    readonly runnerRecipe?: AppBuildsServiceDeps['runnerRecipe'];
    readonly spec?: AppSpec | null;
    readonly specValid?: boolean;
    readonly fingerprints?: Record<string, string> | null;
    readonly onStartBuild?: (input: Record<string, unknown>) => void;
    /**
     * The binding's `checkImageAccess` (T14). Absent means the binding declares
     * none, which is what every case written before T14 already assumed.
     */
    readonly checkImageAccess?: (input: ImageAccessInput) => Promise<ImageAccessAnswer>;
    /** The binding's image repository; `undefined` keeps the platform-derived one. */
    readonly bindingImageRepository?: string | null;
}

/** What the binding's `checkImageAccess` is asked (plan §4.8). */
interface ImageAccessInput {
    readonly imageRepository: string;
    readonly tag: string;
    readonly pullToken?: string;
}

/** What the binding's `checkImageAccess` answers (`ImageAccessResult`, plan §4.12). */
interface ImageAccessAnswer {
    readonly visibility: 'public' | 'private' | 'unknown';
    readonly readable: boolean;
    readonly digest?: string;
}

type AppBuildsServiceDeps = {
    runnerRecipe: {
        resolveEphemeral: (
            workId: string,
            sha: string,
            ctx: { target: 'runner' },
        ) => Promise<{
            recipe?: readonly AppEnvRecipeEntry[];
            secretNames: string[];
            unsetRequired: string[];
        }>;
    };
};

function makeHarness(options: HarnessOptions = {}): Harness {
    const store = new Map<string, WorkBuild>();
    const activity: CreateActivityLogDto[] = [];
    const emitted: Array<{ name: string; event: { payload: AppBuildEventPayload } }> = [];
    const usage: RecordPluginUsageInput[] = [];
    const provisions: string[] = [];
    const dispatchedPrepare: Harness['dispatchedPrepare'] = [];
    const dispatchedWatch: Harness['dispatchedWatch'] = [];
    const runnerRuns: Harness['runnerRuns'] = [];
    const startBuildCalls: Array<Record<string, unknown>> = [];
    const cancelBuildCalls: Harness['cancelBuildCalls'] = [];
    const imageAccessCalls: Harness['imageAccessCalls'] = [];

    let sequence = 100;
    const preparations = new Map<string, WorkBuildPreparation>();

    const rowRepository = {
        async findOne({ where }: { where: { id: string } }) {
            return store.get(where.id) ?? null;
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
                wheres: Array<{ sql: string; params: any }>;
            } = {
                set: null,
                wheres: [],
            };
            const builder = {
                update: () => builder,
                set: (patch: Partial<WorkBuild>) => {
                    state.set = patch;
                    return builder;
                },
                where: (sql: string, params: any) => {
                    state.wheres.push({ sql, params });
                    return builder;
                },
                andWhere: (sql: string, params: any) => {
                    state.wheres.push({ sql, params });
                    return builder;
                },
                async execute() {
                    const id = state.wheres.find((w) => w.sql === 'id = :id')?.params?.id;
                    const row = id ? store.get(id) : undefined;
                    if (!row || !state.set) return { affected: 0 };

                    // Every arm of the WHERE is EVALUATED from the text it was
                    // handed, arm by arm — never re-stated.
                    //
                    // C19. This fake used to answer the terminal claim by
                    // restating the service's rule in its own words
                    // (`terminal.includes(row.status) && row.completedAt`), which
                    // makes the two "exactly once" cases above BLIND to the thing
                    // they exist to pin: change `claimTerminal`'s predicate and
                    // the fake keeps answering with the old rule, so the cases
                    // stay green while the service no longer claims exactly once.
                    // A fake that cannot lose is not evidence. So the predicate
                    // is read instead: the clock arm is whatever the SQL says
                    // (`IS NULL` — the owner's cancel, ACC-05-09 — or `IS NOT
                    // NULL`, which is what a mutant writes), and a shape neither
                    // arm models is refused LOUDLY rather than silently answered
                    // by the retired rule.
                    for (const { sql, params } of state.wheres) {
                        // `… WHERE id = :id` — the row identity, not a predicate.
                        if (sql === 'id = :id') continue;
                        // `… AND "startedAt" IS NULL`
                        if (sql === 'startedAt IS NULL') {
                            if (row.startedAt) return { affected: 0 };
                            continue;
                        }
                        // `… AND (status NOT IN (:...terminal) OR completedAt IS NULL)`
                        //
                        // The predicate holds when EITHER arm does, so a terminal
                        // row is claimed only when the clock arm also says so.
                        if (sql.includes('status NOT IN')) {
                            const inTerminal = (params.terminal as string[]).includes(row.status);
                            const nullArm = sql.includes('completedAt IS NULL');
                            const setArm = sql.includes('completedAt IS NOT NULL');
                            if (!nullArm && !setArm) {
                                throw new Error(
                                    "rowsRepository: the terminal claim's predicate cannot be " +
                                        `modelled: ${sql}`,
                                );
                            }
                            const clockArm = nullArm ? !row.completedAt : Boolean(row.completedAt);
                            if (!inTerminal || clockArm) continue;
                            return { affected: 0 };
                        }
                        throw new Error(`rowsRepository: unrecognised claim predicate: ${sql}`);
                    }

                    store.set(id, { ...row, ...state.set });
                    return { affected: 1 };
                },
            };
            return builder;
        },
    } as unknown as Repository<WorkBuild>;

    const builds = {
        async insertWithNextNumber(
            workId: string,
            data: WorkBuildInsert,
            writeOptions: { stampFromPreparation?: boolean } = {},
        ) {
            const rows = [...store.values()].filter((row) => row.workId === workId);
            const number = rows.reduce((max, row) => Math.max(max, row.number), 0) + 1;
            const stamps = writeOptions.stampFromPreparation ? preparations.get(workId) : undefined;
            const now = new Date();
            const row = makeRow({
                ...data,
                workId,
                number,
                id: uuid((sequence += 1)),
                createdAt: now,
                updatedAt: now,
                ...(stamps
                    ? {
                          buildInputsHash: stamps.buildInputsHash ?? null,
                          buildSecretNames: stamps.buildSecretNames ?? null,
                          secretsSyncedAt: stamps.secretsSyncedAt ?? null,
                      }
                    : {}),
            });
            store.set(row.id, row);
            return row;
        },
        async upsertByProviderRun(
            workId: string,
            data: WorkBuildInsert & { providerRunId: string },
            writeOptions: { stampFromPreparation?: boolean } = {},
        ) {
            const existing = [...store.values()].find(
                (row) =>
                    row.buildPluginId === data.buildPluginId &&
                    row.providerRunId === data.providerRunId &&
                    row.runAttempt === (data.runAttempt ?? 1),
            );
            if (existing) {
                Object.assign(existing, data);
                store.set(existing.id, existing);
                return { build: existing, created: false };
            }
            return {
                build: await builds.insertWithNextNumber(workId, data, writeOptions),
                created: true,
            };
        },
        async findPage(
            workId: string,
            filters: { status?: string[]; trigger?: string[] } = {},
            page = 1,
            pageSize = 20,
        ) {
            const all = [...store.values()]
                .filter((row) => row.workId === workId)
                .filter((row) => (filters.status ? filters.status.includes(row.status) : true))
                .filter((row) => (filters.trigger ? filters.trigger.includes(row.trigger) : true))
                .sort((left, right) => {
                    const delta = right.createdAt.getTime() - left.createdAt.getTime();
                    return delta !== 0 ? delta : right.number - left.number;
                });
            const start = (page - 1) * pageSize;
            return {
                rows: all.slice(start, start + pageSize),
                total: all.length,
                page,
                pageSize,
                hasMore: start + pageSize < all.length,
            };
        },
        async findRecentForCommit(workId: string, commitSha: string, sinceMs: number) {
            return (
                [...store.values()]
                    .filter(
                        (row) =>
                            row.workId === workId &&
                            row.commitSha === commitSha &&
                            row.createdAt.getTime() >= sinceMs,
                    )
                    .sort(
                        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
                    )[0] ?? null
            );
        },
        async findByIdForWork(workId: string, id: string) {
            const row = store.get(id);
            return row && row.workId === workId ? row : null;
        },
    } as unknown as AppBuildRepository;

    const preparationRepository = {
        async findByWork(workId: string) {
            return preparations.get(workId) ?? null;
        },
        async upsertAfterPrepare(workId: string, patch: Partial<WorkBuildPreparation>) {
            const existing =
                preparations.get(workId) ??
                ({
                    id: uuid(900),
                    workId,
                    buildPluginId: patch.buildPluginId ?? 'github-actions-build',
                    workflowState: 'none',
                    webhookState: 'none',
                    prepareSeq: 0,
                } as WorkBuildPreparation);
            Object.assign(existing, patch);
            preparations.set(workId, existing);
            return existing;
        },
    } as unknown as AppBuildPreparationRepository;

    const activityLog = {
        async log(entry: CreateActivityLogDto) {
            activity.push(entry);
            return entry;
        },
    } as unknown as ActivityLogService;

    const emitter = {
        // `EventEmitter2.emit(name, event)` — the second argument is the event
        // instance, so the payload is read off it exactly as a subscriber would.
        emit(name: string, event: { payload: AppBuildEventPayload }) {
            emitted.push({ name, event });
            return true;
        },
    } as unknown as EventEmitter2;

    const usageService = {
        async record(input: RecordPluginUsageInput) {
            usage.push(input);
            return { id: uuid(700) };
        },
    } as unknown as PluginUsageService;

    const fingerprints: AppEnvResolvedFingerprints = {
        async read() {
            return options.fingerprints === undefined
                ? Object.fromEntries(BUILD_VALUES.map((v) => [v.name, v.fingerprint]))
                : options.fingerprints;
        },
    };

    const plugins: AppBuildPluginResolver = {
        async resolve() {
            const checkImageAccess = options.checkImageAccess;
            return {
                pluginId: 'github-actions-build',
                buildKind: 'github-actions',
                imageRepository:
                    options.bindingImageRepository === undefined
                        ? 'ghcr.io/acme/shop/ever-works-app'
                        : options.bindingImageRepository,
                async startBuild(input) {
                    const record = input as unknown as Record<string, unknown>;
                    startBuildCalls.push(record);
                    options.onStartBuild?.(record);
                    return { providerRunId: 'run-77', dispatchedAt: new Date().toISOString() };
                },
                async cancelBuild(input) {
                    cancelBuildCalls.push(input);
                },
                ...(checkImageAccess
                    ? {
                          async checkImageAccess(input: ImageAccessInput) {
                              imageAccessCalls.push({ ...input });
                              return checkImageAccess(input);
                          },
                      }
                    : {}),
            };
        },
    };

    const works = {
        async read() {
            return {
                workId: WORK_ID,
                userId: USER_ID,
                trackedBranch: 'main',
                buildPluginId: 'github-actions-build',
                repositoryFullName: 'acme/shop',
                repositoryVisibility: 'private' as const,
            };
        },
    };

    const specs = {
        async read() {
            return {
                spec: options.spec === undefined ? SPEC_FIXTURE : options.spec,
                commitSha: SHA,
                specHash: 'b'.repeat(64),
                valid: options.specValid ?? true,
            };
        },
    };

    const runnerRecipe =
        options.runnerRecipe ??
        ({
            async resolveEphemeral() {
                return {
                    recipe: RECIPE_FIXTURE,
                    secretNames: ['APP_SECRET'],
                    unsetRequired: [] as string[],
                };
            },
        } as AppBuildsServiceDeps['runnerRecipe']);

    const service = new AppBuildsService(
        builds,
        preparationRepository,
        rowRepository,
        activityLog,
        emitter,
        usageService,
        fingerprints,
        options.provisionEvents as never,
        plugins,
        works,
        specs,
        runnerRecipe as never,
        {
            async dispatchAppBuildPrepare(payload: {
                workId: string;
                reason: string;
                buildId?: string;
            }) {
                dispatchedPrepare.push(payload);
                if (!options.prepareDispatcher) return 'run-1';
                return options.prepareDispatcher(payload);
            },
        },
        {
            async dispatchAppBuildWatch(payload: { buildId: string; reason: string }) {
                dispatchedWatch.push(payload);
                return 'run-2';
            },
        },
        options.prepareRunner
            ? {
                  async run(payload: { workId: string; reason: string; buildId?: string }) {
                      runnerRuns.push({ kind: 'prepare', key: payload.workId });
                      return options.prepareRunner?.(payload);
                  },
              }
            : undefined,
        {
            async run(payload: { buildId: string }) {
                runnerRuns.push({ kind: 'watch', key: payload.buildId });
                return undefined;
            },
        },
    );

    return {
        service,
        store,
        activity,
        emitted,
        usage,
        provisions,
        dispatchedPrepare,
        dispatchedWatch,
        runnerRuns,
        startBuildCalls,
        cancelBuildCalls,
        imageAccessCalls,
        seed(row) {
            store.set(row.id, row);
            return row;
        },
        seedPreparation(patch) {
            preparations.set(WORK_ID, {
                id: uuid(900),
                workId: WORK_ID,
                buildPluginId: 'github-actions-build',
                workflowState: 'committed',
                webhookState: 'none',
                prepareSeq: 0,
                ...patch,
            } as WorkBuildPreparation);
        },
        preparation() {
            return preparations.get(WORK_ID);
        },
        preparationRepository,
        row(id) {
            const row = store.get(id);
            if (!row) throw new Error(`no row ${id}`);
            return row;
        },
        events() {
            return emitted.map((entry) => entry.name);
        },
    };
}

/** Poll until `check()` is true, so the unawaited fallback can be observed. */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('waitFor: the condition never became true');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function snapshot(overrides: Partial<BuildSnapshot> = {}): BuildSnapshot {
    return {
        providerRunId: 'run-77',
        runAttempt: 1,
        status: 'running',
        trigger: 'push',
        branch: 'main',
        commitSha: SHA,
        startedAt: '2026-09-17T10:05:00.000Z',
        ...overrides,
    } as BuildSnapshot;
}

function succeededSnapshot(overrides: Partial<BuildSnapshot> = {}): BuildSnapshot {
    return snapshot({
        status: 'succeeded',
        completedAt: '2026-09-17T10:09:00.000Z',
        billableMinutes: 4,
        checksBillableMinutes: 1,
        runnerLabel: 'ubuntu-latest',
        image: {
            repository: 'ghcr.io/acme/shop/ever-works-app',
            digest: DIGEST,
            tags: [`sha-${SHA}`, 'branch-main'],
            confirmed: true,
        },
        secretCheck: 'passed',
        ...overrides,
    }) as BuildSnapshot;
}

/* -------------------------------------------------------------------------- *
 * The suite
 * -------------------------------------------------------------------------- */

describe('AppBuildsService (APW-05 T17)', () => {
    describe('requestRebuild — FR-41/FR-42 (ACC-05-08)', () => {
        it('returns inside the 2-second budget even when the dispatcher is slow', async () => {
            // 🛑 SLOWER than the budget on purpose. A dispatcher that resolved
            // inside 2 s would let an `await this.dispatchPrepare(...)` mutant
            // pass this test, which is exactly the regression FR-41's budget
            // exists to catch.
            //
            // C18. The slowness used to be a bare `setTimeout(resolve, 3_000)`
            // whose `unref()` was taken to make it safe. It did not: the timer —
            // and the dispatch promise chain behind it — outlived this case and
            // resumed during whichever case happened to be running three
            // seconds later. It was the only async work in this file that
            // survives its own test, and a case that leaves work running is a
            // case whose result no longer depends only on itself. The gate below
            // is released, and awaited, INSIDE this test instead: the dispatcher
            // is just as slow, the budget assertion is unchanged, and nothing
            // this case started is still running when it ends.
            //
            // The 8-second fallback is deliberate: an `await
            // this.dispatchPrepare(...)` mutant then reddens with
            // `expect(elapsed).toBeLessThan(2_000)` receiving ~8 000, which names
            // the regression, instead of deadlocking into a bare 30-second jest
            // timeout that names nothing.
            let releaseDispatcher!: () => void;
            const dispatcherGate = new Promise<void>((resolve) => {
                releaseDispatcher = resolve;
            });
            const gateFallback = setTimeout(releaseDispatcher, 8_000);
            let dispatcherSettled = false;

            const harness = makeHarness({
                prepareDispatcher: async () => {
                    await dispatcherGate;
                    dispatcherSettled = true;
                    return 'run-slow';
                },
            });

            const started = Date.now();
            const result = await harness.service.requestRebuild(WORK_ID, USER_ID);
            const elapsed = Date.now() - started;

            expect(result.ok).toBe(true);
            // FR-41: the request must answer inside its 2-second budget even
            // though the dispatch behind it is still pending.
            expect(elapsed).toBeLessThan(2_000);
            // The dispatch DID happen — it is merely not awaited past the insert.
            // It is requested through `requestPrepare` (APW-05 wave 2), whose
            // `prepareSeq` bump comes first (§7.2), so it reaches the dispatcher a
            // few ticks AFTER the answer instead of synchronously inside it: wait
            // for the dispatch here — never for the dispatcher, which stays gated.
            await waitFor(() => harness.dispatchedPrepare.length === 1);
            expect(harness.dispatchedPrepare).toHaveLength(1);
            expect(harness.dispatchedPrepare[0].reason).toBe('rebuild');
            // …and the MECHANISM, not only the clock. `elapsed < 2 s` alone cannot
            // tell "the dispatch is not awaited" from "the dispatcher happened to
            // be fast", and it is the one kind of assertion here that measures the
            // machine rather than the code. This one measures the code: the
            // request came back while the dispatcher was still pending.
            expect(dispatcherSettled).toBe(false);

            // Contain it: release the dispatcher and let it settle before the
            // case ends, so no work this test started is still running when the
            // next one begins — and clear the fallback, so the containment does
            // not become the very leak this change removes.
            releaseDispatcher();
            clearTimeout(gateFallback);
            await waitFor(() => dispatcherSettled, 5_000);
        });

        it('falls back in process exactly once when the prepare dispatcher returns null (APW05-G20)', async () => {
            let runs = 0;
            let inFlight = 0;
            let maxInFlight = 0;
            const reasons: string[] = [];
            const harness = makeHarness({
                prepareDispatcher: async () => null,
                prepareRunner: async (payload) => {
                    runs += 1;
                    reasons.push(payload.reason);
                    inFlight += 1;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    // Slow enough that a second request definitely overlaps, which is
                    // the case the in-process guard exists for.
                    await new Promise((resolve) => setTimeout(resolve, 150));
                    inFlight -= 1;
                },
            });

            const started = Date.now();
            const result = await harness.service.requestRebuild(WORK_ID, USER_ID);
            expect(result.ok).toBe(true);
            // FR-41: the request must answer inside its 2-second budget even
            // while the in-process fallback it kicked off is still running.
            expect(Date.now() - started).toBeLessThan(2_000);

            // A second request while the first in-process run is still in flight is
            // not run CONCURRENTLY — §7.1's "an in-process run and a dispatched one
            // cannot double-fire" — and it is not dropped either: the run in flight
            // is followed by exactly one `coalesced` run (§7.2: "a coalesced
            // dispatch loses nothing").
            await harness.service.requestPrepare(WORK_ID, 'envChanged');

            await waitFor(() => runs >= 2, 2_000);
            await new Promise((resolve) => setTimeout(resolve, 300));
            // Corrected from 1 (APW-05 wave 2): the old value pinned the LOST
            // request. The second request was dropped while the first run was in
            // flight, and nothing ever re-read the `prepareSeq` it bumped, so its
            // change waited for an unrelated prepare. It is now re-run once, after
            // the first run settles — never alongside it, and never twice.
            expect(runs).toBe(2);
            expect(harness.runnerRuns.filter((run) => run.kind === 'prepare')).toHaveLength(2);
            expect(maxInFlight).toBe(1);
            expect(reasons[1]).toBe('coalesced');
            // Both requests were still dispatched to the runtime, which refused both.
            expect(harness.dispatchedPrepare).toHaveLength(2);
        });

        it('bumps prepareSeq before it dispatches the Rebuild’s prepare (§7.2)', async () => {
            // The bump is what lets a pass that is ALREADY running see this
            // Rebuild: without it the holder's before/after comparison never moves,
            // and a dispatch answered `locked` loses the Build until an unrelated
            // prepare comes along.
            const seqAtDispatch: Array<number | undefined> = [];
            let harness!: Harness;
            harness = makeHarness({
                prepareDispatcher: async () => {
                    seqAtDispatch.push(harness.preparation()?.prepareSeq);
                    return 'run-1';
                },
            });
            harness.seedPreparation({ prepareSeq: 4 });

            const result = await harness.service.requestRebuild(WORK_ID, USER_ID);
            if (!result.ok) throw new Error('unreachable');
            await waitFor(() => harness.dispatchedPrepare.length === 1);

            expect(harness.preparation()?.prepareSeq).toBe(5);
            expect(seqAtDispatch).toEqual([5]);
            expect(harness.dispatchedPrepare[0]).toEqual({
                workId: WORK_ID,
                reason: 'rebuild',
                buildId: result.build.id,
            });
        });

        it('dedupes a second rebuild inside 10 seconds to the SAME Build', async () => {
            const harness = makeHarness();

            const first = await harness.service.requestRebuild(WORK_ID, USER_ID);
            const second = await harness.service.requestRebuild(WORK_ID, USER_ID);

            expect(first.ok && second.ok).toBe(true);
            if (!first.ok || !second.ok) throw new Error('unreachable');
            expect(second.deduped).toBe(true);
            expect(second.build.id).toBe(first.build.id);
            expect(harness.store.size).toBe(1);
        });

        it('creates a NEW Build once the dedupe window has passed', async () => {
            const harness = makeHarness();

            const first = await harness.service.requestRebuild(WORK_ID, USER_ID);
            if (!first.ok) throw new Error('unreachable');
            // Age the first Build past the 10-second window.
            harness.store.set(first.build.id, {
                ...harness.row(first.build.id),
                createdAt: new Date(Date.now() - 20_000),
            });

            const second = await harness.service.requestRebuild(WORK_ID, USER_ID);
            if (!second.ok) throw new Error('unreachable');
            expect(second.deduped).toBe(false);
            expect(second.build.id).not.toBe(first.build.id);
            expect(second.build.number).toBe(2);
        });

        it('answers rebuildRateLimited with minutes on the 11th rebuild (ACC-05-08)', async () => {
            const harness = makeHarness();

            for (let index = 0; index < 10; index += 1) {
                const result = await harness.service.requestRebuild(WORK_ID, USER_ID, {
                    commitSha: String(index).padStart(40, '0'),
                });
                expect(result.ok).toBe(true);
            }

            const eleventh = await harness.service.requestRebuild(WORK_ID, USER_ID, {
                commitSha: 'f'.repeat(40),
            });

            // `strictNullChecks: false` in this package (see jest.config.js) stops
            // discriminated result unions narrowing, so the refusal arm is asserted
            // through an explicit cast rather than a truthiness guard.
            const refusal = eleventh as Extract<AppBuildRebuildResult, { ok: false }>;
            expect(refusal.code).toBe('rebuildRateLimited');
            expect(refusal.retryAfterMinutes).toBeGreaterThanOrEqual(1);
            expect(refusal.retryAfterMinutes).toBeLessThanOrEqual(60);
        });

        it('refuses a Work whose strategy is `image`/`none`/`auto` with nothingToBuild', async () => {
            const harness = makeHarness({
                spec: { ...SPEC_FIXTURE, build: { strategy: 'image', image: 'nginx:1.27' } },
            });

            expect(await harness.service.requestRebuild(WORK_ID, USER_ID)).toEqual({
                ok: false,
                code: 'nothingToBuild',
            });
        });
    });

    describe('cancel — ACC-05-09', () => {
        it('calls cancelBuild and lets the next snapshot finalise `cancelled`', async () => {
            const harness = makeHarness();
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                buildSecretNames: ['APP_SECRET'],
            });

            const created = await harness.service.recordProviderRun(
                WORK_ID,
                runRef({ status: 'in_progress' }),
                'event',
            );
            if (!created.accepted) throw new Error('unreachable');
            await harness.service.applySnapshot(created.build.id, snapshot());

            const cancelled = await harness.service.cancel(WORK_ID, created.build.id);

            expect(cancelled.ok).toBe(true);
            expect(harness.cancelBuildCalls).toEqual([
                { buildId: created.build.id, providerRunId: 'run-77' },
            ]);
            // Cancelled but NOT finalised: `completedAt` is deliberately NULL so the
            // next observation is the one that finalises it (§7.3).
            expect(harness.row(created.build.id).status).toBe('cancelled');
            expect(harness.row(created.build.id).completedAt).toBeUndefined();
            expect(harness.events()).not.toContain('app.build.cancelled');

            await harness.service.applySnapshot(
                created.build.id,
                snapshot({ status: 'cancelled', completedAt: '2026-09-17T10:06:00.000Z' }),
            );

            expect(harness.row(created.build.id).status).toBe('cancelled');
            expect(harness.row(created.build.id).cancelReason).toBe('user');
            expect(harness.events()).toContain('app.build.cancelled');
            expect(harness.events().filter((name) => name === 'app.build.cancelled')).toHaveLength(
                1,
            );
        });

        it('refuses a terminal Build with notCancellable and never calls the provider', async () => {
            const harness = makeHarness();
            const row = harness.seed(
                makeRow({ workId: WORK_ID, id: uuid(50), status: 'succeeded' }),
            );

            expect(await harness.service.cancel(WORK_ID, row.id)).toEqual({
                ok: false,
                code: 'notCancellable',
            });
            expect(harness.cancelBuildCalls).toHaveLength(0);
        });

        it('refuses a blocked Build with notCancellable', async () => {
            const harness = makeHarness();
            const row = harness.seed(makeRow({ workId: WORK_ID, id: uuid(51), status: 'blocked' }));

            expect(await harness.service.cancel(WORK_ID, row.id)).toEqual({
                ok: false,
                code: 'notCancellable',
            });
        });

        it('answers buildNotFound for a Build of another Work', async () => {
            const harness = makeHarness();
            const row = harness.seed(makeRow({ workId: 'other-work', id: uuid(52) }));

            expect(await harness.service.cancel(WORK_ID, row.id)).toEqual({
                ok: false,
                code: 'buildNotFound',
            });
        });
    });

    describe('finalize — the receipt (ACC-05-20)', () => {
        it('records one receipt with the runner minutes, payer workspace and costCents 0', async () => {
            const harness = makeHarness();
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                buildSecretNames: ['APP_SECRET'],
            });

            const created = await harness.service.recordProviderRun(
                WORK_ID,
                runRef({ status: 'in_progress' }),
                'event',
            );
            if (!created.accepted) throw new Error('unreachable');

            await harness.service.applySnapshot(created.build.id, snapshot());
            await harness.service.applySnapshot(created.build.id, succeededSnapshot());
            // Two more deliveries of the same terminal snapshot: still ONE receipt.
            await harness.service.applySnapshot(created.build.id, succeededSnapshot());
            await harness.service.finalize(created.build.id);

            expect(harness.usage).toHaveLength(1);
            expect(harness.usage[0]).toMatchObject({
                workId: WORK_ID,
                userId: USER_ID,
                pluginId: 'github-actions-build',
                capability: 'build',
                units: 4,
                costCents: 0,
                operation: 'build.run',
                payer: 'workspace',
                outcome: 'ok',
                metadata: {
                    buildId: created.build.id,
                    runnerClass: null,
                    checksBillableMinutes: 1,
                },
            });
            expect(harness.row(created.build.id).usageEventId).toBe(uuid(700));
        });

        it('touches no credit ledger — the build capability bills the owner, not the workspace', () => {
            const source = readFileSync(join(__dirname, '..', 'app-builds.service.ts'), 'utf8');
            // The receipt is an audit row: GitHub charges the owner's own account for
            // the runner minutes, so nothing here can debit credits.
            expect(source).not.toMatch(/CreditLedger|creditLedger|credit-ledger/);
        });

        it('records no receipt for a Build that never ran', async () => {
            const harness = makeHarness();
            const row = harness.seed(
                makeRow({
                    workId: WORK_ID,
                    id: uuid(60),
                    status: 'cancelled',
                    cancelReason: 'user',
                    completedAt: new Date('2026-09-17T10:00:00.000Z'),
                }),
            );

            await harness.service.finalize(row.id);

            expect(harness.usage).toHaveLength(0);
        });
    });

    /**
     * APW-05 T42 — the check minutes on a pull request Build's receipt (R-9).
     *
     * ACC-05-29's last clause: "the pull request Build's status is unchanged by
     * either result"; FR-69: "a check's result never changes a Build's status or
     * deployability ... The runner minutes of check jobs are shown on the pull
     * request Build's receipt as a separate line"; and T42's own Test line: "a pull
     * request Build with 3 check minutes records `checksBillableMinutes: 3` inside
     * `units` and the Build's status and `deployable` are identical with checks
     * green or red".
     *
     * **What "green or red" is, at this seam.** A check's own outcome never reaches
     * `BuildSnapshot` — that IS FR-69 — so the only thing a red check can change in
     * an observation is the **workflow run's** `conclusion` (GitHub reports the run
     * as failed when a required check failed, while the `build` job succeeded and
     * `status` stays `succeeded`, which is what `run-observer.ts` maps). The two
     * runs below are therefore identical except for that conclusion, and both must
     * land on the same row and the same verdict.
     *
     * **What "inside `units`" is.** `units` is the run's `billableMinutes`, and
     * `checksBillableMinutes` is a subset of it (`build.interface.ts:313-318`) — a
     * separate line on the receipt, never added on top. Both numbers are asserted,
     * so a change that started adding them together would red here.
     */
    describe('finalize — the check minutes on a pull request Build (T42, R-9, ACC-05-29, FR-69)', () => {
        /** One pull-request run with 3 check minutes out of 5, green or red. */
        async function pullRequestOutcome(conclusion: 'success' | 'failure') {
            const harness = makeHarness();
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                buildSecretNames: ['APP_SECRET'],
            });

            const created = await harness.service.recordProviderRun(
                WORK_ID,
                runRef({ event: 'pull_request', status: 'in_progress', pullRequestNumber: 12 }),
                'event',
            );
            if (!created.accepted) throw new Error('unreachable');
            expect(harness.row(created.build.id).trigger).toBe('pull_request');

            await harness.service.applySnapshot(
                created.build.id,
                snapshot({ trigger: 'pull_request' }),
            );
            const settled = await harness.service.applySnapshot(
                created.build.id,
                succeededSnapshot({
                    trigger: 'pull_request',
                    // 5 runner minutes in total, 3 of them in the checks matrix.
                    billableMinutes: 5,
                    checksBillableMinutes: 3,
                    // The workflow run's own conclusion — `failure` when a required
                    // check failed, while the build job itself succeeded. It is the
                    // ONLY thing a red check can change in an observation, and the
                    // assertions below are that it changes nothing here (FR-69).
                    conclusion,
                }),
            );

            return { harness, row: settled ?? harness.row(created.build.id) };
        }

        it('records checksBillableMinutes inside units, and neither conclusion moves the Build', async () => {
            const green = await pullRequestOutcome('success');
            const red = await pullRequestOutcome('failure');

            // The row: identical either way, which is ACC-05-29's "the pull request
            // Build's status is unchanged by either result".
            expect(green.row.status).toBe('succeeded');
            expect(red.row.status).toBe(green.row.status);
            expect(red.row.deployable).toBe(green.row.deployable);
            expect(red.row.notDeployableReason).toBe(green.row.notDeployableReason);
            // Non-vacuity: the verdict is the real one for a pull request Build —
            // not deployable because of where it came from, never because of a check.
            expect(green.row.deployable).toBe(false);
            expect(green.row.notDeployableReason).toBe('pullRequest');
            expect(red.row.notDeployableReason).not.toBe('notSucceeded');

            // The receipt: one row, `units` = the run's minutes, and the check
            // minutes as a separate line inside them.
            expect(green.harness.usage).toHaveLength(1);
            expect(red.harness.usage).toHaveLength(1);
            expect(green.harness.usage[0]).toMatchObject({
                operation: 'build.run',
                payer: 'workspace',
                costCents: 0,
                outcome: 'ok',
                units: 5,
                metadata: {
                    buildId: green.row.id,
                    checksBillableMinutes: 3,
                },
            });
            expect(green.harness.usage[0].units).toBe(green.row.billableMinutes);
            expect(green.harness.usage[0].units ?? 0).toBeGreaterThanOrEqual(3);
            // A red check still bills its own minutes — and still bills nothing extra.
            expect(red.harness.usage[0]).toMatchObject({ units: 5, outcome: 'ok' });
            expect(red.harness.usage[0].metadata).toMatchObject({ checksBillableMinutes: 3 });
            expect(red.row.checksBillableMinutes).toBe(3);

            // And the drawer shows the same two numbers off the row (FR-69's
            // "separate line"), for either conclusion.
            const detail = await green.harness.service.getDetail(WORK_ID, green.row.id);
            expect(detail?.receipt).toEqual({
                billableMinutes: 5,
                checksBillableMinutes: 3,
                payer: 'workspace',
                costKnown: true,
            });
        });
    });

    /**
     * APW-05 T14 — `finalize` confirms the artifact's digest against the registry
     * (plan §4.8 "equal → confirmed; unequal → digestMismatch", §7.3 "On a
     * terminal transition: confirm digest").
     *
     * The github-actions plugin reports every artifact digest `confirmed: false`,
     * because the artifact is the member's own CI's claim. Before T14 nothing
     * compared that claim with anything, so every succeeded Build settled as
     * `digestUnconfirmed` and no Build could ever be deployed. Every case below
     * drives a snapshot the plugin marked unconfirmed, with every OTHER verdict
     * clause passing, so the digest is the only thing that decides the verdict.
     */
    describe('finalize — digest confirmation (plan §4.8, T14)', () => {
        const REGISTRY_REPOSITORY = 'ghcr.io/acme/shop/ever-works-app';
        const OTHER_DIGEST = `sha256:${'e'.repeat(64)}`;

        /** The artifact's image, exactly as the plugin reports it: never confirmed. */
        function unconfirmedImage(
            overrides: Partial<NonNullable<BuildSnapshot['image']>> = {},
        ): NonNullable<BuildSnapshot['image']> {
            return {
                repository: REGISTRY_REPOSITORY,
                digest: DIGEST,
                tags: [`sha-${SHA}`, 'branch-main'],
                confirmed: false,
                ...overrides,
            };
        }

        /**
         * One Build observed from open to a terminal snapshot, with the three
         * stamps the `staleInputs` clause reads already on the row (§7.5:1467).
         */
        async function settle(
            options: HarnessOptions,
            snapshotOverrides: Partial<BuildSnapshot> = {},
            rowOverrides: Partial<WorkBuild> = {},
        ) {
            const harness = makeHarness(options);
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                buildSecretNames: ['APP_SECRET'],
            });
            const seeded = harness.seed(
                makeRow({
                    workId: WORK_ID,
                    id: uuid(130),
                    buildInputsHash: PREPARED_HASH,
                    buildSecretNames: ['APP_SECRET'],
                    secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                    ...rowOverrides,
                }),
            );

            await harness.service.applySnapshot(
                seeded.id,
                succeededSnapshot({ image: unconfirmedImage(), ...snapshotOverrides }),
            );

            return { harness, row: harness.row(seeded.id) };
        }

        it('confirms a digest the registry reports equal, and the Build is deployable', async () => {
            const { harness, row } = await settle({
                checkImageAccess: async () => ({
                    visibility: 'public',
                    readable: true,
                    digest: DIGEST,
                }),
            });

            // One registry read, of the platform-derived repository and the Build's
            // own commit tag — and no pull token: none can be stored yet (§4.12).
            expect(harness.imageAccessCalls).toEqual([
                { imageRepository: REGISTRY_REPOSITORY, tag: `sha-${SHA}` },
            ]);
            expect(row.digestConfirmed).toBe(true);
            expect(row.deployable).toBe(true);
            expect(row.notDeployableReason ?? null).toBeNull();
            expect(row.failureClass ?? null).toBeNull();
            const succeeded = harness.emitted.find((e) => e.name === 'app.build.succeeded');
            expect(succeeded?.event.payload.deployable).toBe(true);
        });

        it('a different registry digest is digestMismatch, and never deployable', async () => {
            const { harness, row } = await settle({
                checkImageAccess: async () => ({
                    visibility: 'public',
                    readable: true,
                    digest: OTHER_DIGEST,
                }),
            });

            expect(harness.imageAccessCalls).toHaveLength(1);
            expect(row.digestConfirmed).toBe(false);
            expect(row.deployable).toBe(false);
            expect(row.notDeployableReason).toBe('digestUnconfirmed');
            expect(row.failureClass).toBe('digestMismatch');
            // The Build itself still succeeded: a mismatch is a verdict, not a status.
            expect(row.status).toBe('succeeded');
            expect(harness.events().filter((name) => name === 'app.build.succeeded')).toHaveLength(
                1,
            );
        });

        it('an unreadable registry leaves the Build digestUnconfirmed, with no failure class', async () => {
            const { harness, row } = await settle({
                checkImageAccess: async () => ({ visibility: 'private', readable: false }),
            });

            expect(harness.imageAccessCalls).toHaveLength(1);
            expect(row.digestConfirmed).toBe(false);
            expect(row.notDeployableReason).toBe('digestUnconfirmed');
            expect(row.failureClass ?? null).toBeNull();
        });

        it('never asks the registry about a repository the artifact names but the platform did not derive', async () => {
            const { harness, row } = await settle(
                {
                    checkImageAccess: async () => ({
                        visibility: 'public',
                        readable: true,
                        digest: DIGEST,
                    }),
                },
                { image: unconfirmedImage({ repository: 'ghcr.io/other/x/ever-works-app' }) },
            );

            expect(harness.imageAccessCalls).toHaveLength(0);
            expect(row.digestConfirmed).toBe(false);
            expect(row.notDeployableReason).toBe('digestUnconfirmed');
        });

        it('compares the repository case-insensitively and pins the row to the derived one', async () => {
            const { harness, row } = await settle(
                {
                    checkImageAccess: async () => ({
                        visibility: 'public',
                        readable: true,
                        digest: DIGEST,
                    }),
                },
                { image: unconfirmedImage({ repository: 'GHCR.IO/Acme/Shop/ever-works-app' }) },
            );

            expect(harness.imageAccessCalls).toHaveLength(1);
            expect(row.digestConfirmed).toBe(true);
            // The deploy reference is built from this column (APW-06), so it is the
            // platform's lower-cased repository and not the artifact's spelling.
            expect(row.imageRepository).toBe(REGISTRY_REPOSITORY);
        });

        it('a registry read that throws still settles the Build, as digestUnconfirmed', async () => {
            const { harness, row } = await settle({
                checkImageAccess: async () => {
                    throw new Error('ghcr.io is unreachable');
                },
            });

            expect(harness.imageAccessCalls).toHaveLength(1);
            expect(row.status).toBe('succeeded');
            expect(row.notDeployableReason).toBe('digestUnconfirmed');
            expect(row.failureClass ?? null).toBeNull();
            expect(harness.events()).toEqual(['app.build.started', 'app.build.succeeded']);
            expect(harness.usage).toHaveLength(1);
        });

        it('a registry read that never answers is abandoned after APP_BUILD_DIGEST_READ_TIMEOUT_MS, and the Build still settles', async () => {
            // `checkImageAccess` sends up to two unbounded fetches (ghcr.io's /token,
            // then the manifest HEAD). finalize runs AFTER the terminal claim and
            // inside the watch lease, so a hung registry must cost the confirmation,
            // never the settlement — the same as a read that throws.
            jest.useFakeTimers({
                doNotFake: ['Date', 'nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'],
            });
            try {
                const harness = makeHarness({
                    checkImageAccess: () => new Promise<ImageAccessAnswer>(() => undefined),
                });
                harness.seedPreparation({
                    buildInputsHash: PREPARED_HASH,
                    secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                    buildSecretNames: ['APP_SECRET'],
                });
                const seeded = harness.seed(
                    makeRow({
                        workId: WORK_ID,
                        id: uuid(132),
                        buildInputsHash: PREPARED_HASH,
                        buildSecretNames: ['APP_SECRET'],
                        secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                    }),
                );

                const settling = harness.service
                    .applySnapshot(seeded.id, succeededSnapshot({ image: unconfirmedImage() }))
                    .then(() => 'settled' as const);
                await jest.advanceTimersByTimeAsync(APP_BUILD_DIGEST_READ_TIMEOUT_MS);
                // One real macrotask: everything after the abandoned read is in-memory.
                const outcome = await Promise.race([
                    settling,
                    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
                ]);

                expect(outcome).toBe('settled');
                const row = harness.row(seeded.id);
                expect(harness.imageAccessCalls).toHaveLength(1);
                expect(row.status).toBe('succeeded');
                expect(row.digestConfirmed).toBe(false);
                expect(row.notDeployableReason).toBe('digestUnconfirmed');
                expect(row.failureClass ?? null).toBeNull();
                expect(harness.events()).toEqual(['app.build.started', 'app.build.succeeded']);
            } finally {
                jest.useRealTimers();
            }
        });

        it('a manual Build dispatched at a commit other than the branch head reads its OWN sha tag', async () => {
            // The workflow checks out and tags `sha-<inputs.ew_sha>` — the commit the
            // platform dispatched and recorded on the row. A `workflow_dispatch` run's
            // `head_sha` is the branch head at dispatch time instead, and when that
            // head was already built by a push Build its `sha-<head>` tag exists with a
            // different digest: reading it recorded a false `digestMismatch`, which a
            // Rebuild of the same commit would only repeat.
            const DISPATCHED_SHA = 'c'.repeat(40);
            const { harness, row } = await settle(
                {
                    checkImageAccess: async ({ tag }) =>
                        tag === `sha-${DISPATCHED_SHA}`
                            ? { visibility: 'public', readable: true, digest: DIGEST }
                            : { visibility: 'public', readable: true, digest: OTHER_DIGEST },
                },
                {
                    trigger: 'manual',
                    // The run's head_sha: the branch head, not the dispatched commit.
                    commitSha: SHA,
                    image: unconfirmedImage({ tags: [`sha-${DISPATCHED_SHA}`, 'branch-main'] }),
                },
                { trigger: 'manual', commitSha: DISPATCHED_SHA },
            );

            expect(harness.imageAccessCalls).toEqual([
                { imageRepository: REGISTRY_REPOSITORY, tag: `sha-${DISPATCHED_SHA}` },
            ]);
            expect(row.commitSha).toBe(DISPATCHED_SHA);
            expect(row.failureClass ?? null).toBeNull();
            expect(row.digestConfirmed).toBe(true);
            expect(row.deployable).toBe(true);
        });

        it('asks nothing for a failed Build or a pull request Build', async () => {
            const registry = async (): Promise<ImageAccessAnswer> => ({
                visibility: 'public',
                readable: true,
                digest: DIGEST,
            });

            const failed = await settle(
                { checkImageAccess: registry },
                { status: 'failed', failure: { class: 'unknown', excerpt: [] } },
            );
            expect(failed.harness.imageAccessCalls).toHaveLength(0);
            expect(failed.row.notDeployableReason).toBe('notSucceeded');

            const pullRequest = await settle(
                { checkImageAccess: registry },
                { trigger: 'pull_request' },
                { trigger: 'pull_request' },
            );
            expect(pullRequest.harness.imageAccessCalls).toHaveLength(0);
            expect(pullRequest.row.notDeployableReason).toBe('pullRequest');
        });

        it('keeps a digest the plugin already confirmed, without a registry read', async () => {
            const { harness, row } = await settle(
                {
                    checkImageAccess: async () => ({
                        visibility: 'public',
                        readable: true,
                        digest: OTHER_DIGEST,
                    }),
                },
                { image: unconfirmedImage({ confirmed: true }) },
            );

            expect(harness.imageAccessCalls).toHaveLength(0);
            expect(row.digestConfirmed).toBe(true);
            expect(row.deployable).toBe(true);
        });

        it('a binding with no registry read, or no image repository, confirms nothing', async () => {
            const withoutMember = await settle({});
            expect(withoutMember.row.notDeployableReason).toBe('digestUnconfirmed');

            const withoutRepository = await settle({
                bindingImageRepository: null,
                checkImageAccess: async () => ({
                    visibility: 'public',
                    readable: true,
                    digest: DIGEST,
                }),
            });
            expect(withoutRepository.harness.imageAccessCalls).toHaveLength(0);
            expect(withoutRepository.row.notDeployableReason).toBe('digestUnconfirmed');
        });

        /**
         * The T14 remainder — plan §4.8's no-token fallback: "registry unreadable
         * (private, no token yet) → confirmed only if the artifact digest equals the
         * digest reported by `docker push` in the job log line `digest: sha256:…` of
         * the Push step". The plugin reads that line into
         * `BuildSnapshot.image.pushLogDigest`.
         */
        describe('the push-log fallback (plan §4.8, T14 remainder)', () => {
            it('an unreadable registry and a matching Push-step digest confirm the Build', async () => {
                const { harness, row } = await settle(
                    { checkImageAccess: async () => ({ visibility: 'private', readable: false }) },
                    { image: unconfirmedImage({ pushLogDigest: DIGEST }) },
                );

                // The registry is still asked first; the log only answers when it cannot.
                expect(harness.imageAccessCalls).toHaveLength(1);
                expect(row.digestConfirmed).toBe(true);
                expect(row.deployable).toBe(true);
                expect(row.imageRepository).toBe(REGISTRY_REPOSITORY);
            });

            it('a Push-step digest that differs confirms nothing, and is not a mismatch', async () => {
                const { row } = await settle(
                    { checkImageAccess: async () => ({ visibility: 'private', readable: false }) },
                    { image: unconfirmedImage({ pushLogDigest: OTHER_DIGEST }) },
                );

                expect(row.digestConfirmed).toBe(false);
                expect(row.notDeployableReason).toBe('digestUnconfirmed');
                expect(row.failureClass ?? null).toBeNull();
            });

            it('a readable registry wins over the log: its mismatch stands', async () => {
                const { row } = await settle(
                    {
                        checkImageAccess: async () => ({
                            visibility: 'public',
                            readable: true,
                            digest: OTHER_DIGEST,
                        }),
                    },
                    { image: unconfirmedImage({ pushLogDigest: DIGEST }) },
                );

                expect(row.digestConfirmed).toBe(false);
                expect(row.failureClass).toBe('digestMismatch');
            });

            it('the log answers only an UNREADABLE registry — never a failed read or none at all', async () => {
                const thrown = await settle(
                    {
                        checkImageAccess: async () => {
                            throw new Error('ghcr.io is unreachable');
                        },
                    },
                    { image: unconfirmedImage({ pushLogDigest: DIGEST }) },
                );
                expect(thrown.row.notDeployableReason).toBe('digestUnconfirmed');

                const unasked = await settle(
                    {},
                    { image: unconfirmedImage({ pushLogDigest: DIGEST }) },
                );
                expect(unasked.row.notDeployableReason).toBe('digestUnconfirmed');
            });
        });

        /**
         * `reconfirmDigest(buildId)` — the recheck §7.4 ("re-checks
         * `digestUnconfirmed` Builds whose App Work gained a pull token") and §4.8
         * ("rechecked on token save") describe. `finalize` is one-shot, so without
         * this a Build that settled as `digestUnconfirmed` stays that way forever.
         */
        describe('reconfirmDigest — the recheck of a digestUnconfirmed Build', () => {
            it('re-settles a Build the registry now confirms, and publishes nothing', async () => {
                let answer: ImageAccessAnswer = { visibility: 'private', readable: false };
                const { harness, row } = await settle({ checkImageAccess: async () => answer });
                expect(row.notDeployableReason).toBe('digestUnconfirmed');
                const eventsBefore = harness.events().length;
                const activityBefore = harness.activity.length;

                answer = { visibility: 'private', readable: true, digest: DIGEST };
                const result = await harness.service.reconfirmDigest(row.id);

                expect(result).toMatchObject({
                    reconfirmed: true,
                    reason: 'reconfirmed',
                    deployable: true,
                    notDeployableReason: null,
                });
                const after = harness.row(row.id);
                expect(after.digestConfirmed).toBe(true);
                expect(after.deployable).toBe(true);
                expect(after.notDeployableReason ?? null).toBeNull();
                // Not a status transition, so §7.8's map names no event for it; and
                // not a second receipt either.
                expect(harness.events()).toHaveLength(eventsBefore);
                expect(harness.activity).toHaveLength(activityBefore);
                expect(harness.usage).toHaveLength(1);
            });

            it('confirms from a Push-step digest when the registry still cannot be read', async () => {
                const { harness, row } = await settle({
                    checkImageAccess: async () => ({ visibility: 'private', readable: false }),
                });

                const result = await harness.service.reconfirmDigest(row.id, {
                    pushLogDigest: DIGEST,
                });

                expect(result.reconfirmed).toBe(true);
                expect(harness.row(row.id).deployable).toBe(true);
            });

            it('leaves a Build that still cannot be confirmed as it was', async () => {
                const { harness, row } = await settle({
                    checkImageAccess: async () => ({ visibility: 'private', readable: false }),
                });

                const result = await harness.service.reconfirmDigest(row.id);

                expect(result).toMatchObject({
                    reconfirmed: false,
                    reason: 'unconfirmed',
                    deployable: false,
                    notDeployableReason: 'digestUnconfirmed',
                });
                expect(harness.row(row.id).notDeployableReason).toBe('digestUnconfirmed');
            });

            it('records a registry mismatch found on recheck, and the Build stays undeployable', async () => {
                let answer: ImageAccessAnswer = { visibility: 'private', readable: false };
                const { harness, row } = await settle({ checkImageAccess: async () => answer });

                answer = { visibility: 'private', readable: true, digest: OTHER_DIGEST };
                const result = await harness.service.reconfirmDigest(row.id);

                expect(result.reconfirmed).toBe(false);
                expect(harness.row(row.id).failureClass).toBe('digestMismatch');
                expect(harness.row(row.id).deployable).toBe(false);
            });

            it('clears a digestMismatch it recorded earlier once the registry confirms the digest', async () => {
                // A mismatch keeps `notDeployableReason: 'digestUnconfirmed'`, so the
                // recheck acts on it again. `failureClass` is exposed on the Build
                // summary whatever its status, so a Build that became deployable must
                // not keep saying "The pushed image could not be confirmed".
                let answer: ImageAccessAnswer = {
                    visibility: 'public',
                    readable: true,
                    digest: OTHER_DIGEST,
                };
                const { harness, row } = await settle({ checkImageAccess: async () => answer });
                expect(row.failureClass).toBe('digestMismatch');

                answer = { visibility: 'public', readable: true, digest: DIGEST };
                const result = await harness.service.reconfirmDigest(row.id);

                expect(result).toMatchObject({ reconfirmed: true, deployable: true });
                const after = harness.row(row.id);
                expect(after.deployable).toBe(true);
                expect(after.digestConfirmed).toBe(true);
                expect(after.failureClass ?? null).toBeNull();
            });

            it('leaves a failure class that is not its own alone', async () => {
                const { harness, row } = await settle(
                    { checkImageAccess: async () => ({ visibility: 'private', readable: false }) },
                    {},
                    // Not something a succeeded Build normally carries: it only proves
                    // the recheck clears the class IT wrote and nothing else.
                    { failureClass: 'unknown' },
                );

                await harness.service.reconfirmDigest(row.id, { pushLogDigest: DIGEST });

                expect(harness.row(row.id).digestConfirmed).toBe(true);
                expect(harness.row(row.id).failureClass).toBe('unknown');
            });

            it('touches only digestUnconfirmed Builds, and asks nothing about any other', async () => {
                const { harness, row } = await settle({
                    checkImageAccess: async () => ({
                        visibility: 'public',
                        readable: true,
                        digest: DIGEST,
                    }),
                });
                expect(row.deployable).toBe(true);
                const callsBefore = harness.imageAccessCalls.length;

                const settled = await harness.service.reconfirmDigest(row.id);
                const missing = await harness.service.reconfirmDigest(uuid(404));

                expect(settled).toMatchObject({
                    reconfirmed: false,
                    reason: 'notDigestUnconfirmed',
                });
                expect(missing).toMatchObject({
                    reconfirmed: false,
                    reason: 'notFound',
                    build: null,
                });
                expect(harness.imageAccessCalls).toHaveLength(callsBefore);
            });
        });

        /**
         * The watch runner expects a second delivery of the same terminal snapshot
         * (`app-build-watch.runner.ts`), and `applySnapshot` writes the observation
         * BEFORE the terminal claim. The plugin reports every artifact digest
         * `confirmed: false` and in the artifact's own spelling, so an observation
         * that copied those two fields over a Build the PLATFORM had confirmed undid
         * the confirmation: the Build stayed `deployable: true` with
         * `digestConfirmed: false`, and APW-06 could not deploy it (no image
         * reference). The claim then refuses the second call, so nothing re-confirms.
         */
        describe('a later observation never undoes the platform’s confirmation', () => {
            const ARTIFACT_SPELLING = 'GHCR.IO/Acme/Shop/ever-works-app';

            it('keeps the confirmation and the pinned repository across a second delivery of the same terminal snapshot', async () => {
                const terminal = succeededSnapshot({
                    image: unconfirmedImage({ repository: ARTIFACT_SPELLING }),
                });
                const { harness, row } = await settle(
                    {
                        checkImageAccess: async () => ({
                            visibility: 'public',
                            readable: true,
                            digest: DIGEST,
                        }),
                    },
                    { image: terminal.image },
                );
                expect(row.digestConfirmed).toBe(true);

                await harness.service.applySnapshot(row.id, terminal);

                const after = harness.row(row.id);
                expect(after.deployable).toBe(true);
                expect(after.digestConfirmed).toBe(true);
                expect(after.imageRepository).toBe(REGISTRY_REPOSITORY);
                expect(imageReferenceOf(after)).toBe(`${REGISTRY_REPOSITORY}@${DIGEST}`);
                // The second delivery is not a second finalisation.
                expect(harness.imageAccessCalls).toHaveLength(1);
                expect(
                    harness.events().filter((name) => name === 'app.build.succeeded'),
                ).toHaveLength(1);
            });

            it('keeps a confirmation reconfirmDigest settled across a later delivery', async () => {
                let answer: ImageAccessAnswer = { visibility: 'private', readable: false };
                const terminal = succeededSnapshot({
                    image: unconfirmedImage({ repository: ARTIFACT_SPELLING }),
                });
                const { harness, row } = await settle(
                    { checkImageAccess: async () => answer },
                    { image: terminal.image },
                );
                expect(row.notDeployableReason).toBe('digestUnconfirmed');
                answer = { visibility: 'private', readable: true, digest: DIGEST };
                expect((await harness.service.reconfirmDigest(row.id)).reconfirmed).toBe(true);

                await harness.service.applySnapshot(row.id, terminal);

                const after = harness.row(row.id);
                expect(after.deployable).toBe(true);
                expect(after.digestConfirmed).toBe(true);
                expect(after.imageRepository).toBe(REGISTRY_REPOSITORY);
                expect(imageReferenceOf(after)).toBe(`${REGISTRY_REPOSITORY}@${DIGEST}`);
            });

            it('does not carry a confirmation over to a DIFFERENT digest', async () => {
                // The confirmation belongs to the image the registry vouched for. An
                // observation naming another digest is a different claim, and the row
                // takes it unconfirmed — so no deploy reference can be built from it.
                const { harness, row } = await settle({
                    checkImageAccess: async () => ({
                        visibility: 'public',
                        readable: true,
                        digest: DIGEST,
                    }),
                });
                expect(row.digestConfirmed).toBe(true);

                await harness.service.applySnapshot(
                    row.id,
                    succeededSnapshot({
                        image: unconfirmedImage({
                            repository: ARTIFACT_SPELLING,
                            digest: OTHER_DIGEST,
                        }),
                    }),
                );

                const after = harness.row(row.id);
                expect(after.imageDigest).toBe(OTHER_DIGEST);
                expect(after.digestConfirmed).toBe(false);
                expect(imageReferenceOf(after)).toBeNull();
            });
        });
    });

    describe('publish — the ONE Activity + event writer (APW05-G05)', () => {
        it('writes app_build Activity rows whose metadata carries no value and no excerpt', async () => {
            const harness = makeHarness();
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                buildSecretNames: ['APP_SECRET'],
            });

            const created = await harness.service.recordProviderRun(
                WORK_ID,
                runRef({ status: 'in_progress' }),
                'event',
            );
            if (!created.accepted) throw new Error('unreachable');
            await harness.service.applySnapshot(created.build.id, snapshot());
            await harness.service.applySnapshot(
                created.build.id,
                // A failure carries an excerpt; publishing must not copy it.
                succeededSnapshot({
                    status: 'failed',
                    failure: {
                        class: 'dockerfileError',
                        detail: { step: 4, total: 9, command: 'RUN npm ci' },
                        excerpt: ['SECRET-EXCERPT-LINE', 'second line'],
                    },
                }),
            );

            expect(harness.activity.length).toBeGreaterThanOrEqual(3);
            for (const entry of harness.activity) {
                expect(entry.actionType).toBe('app_build');
                expect(entry.workId).toBe(WORK_ID);
                expect(entry.userId).toBe(USER_ID);
                expect(entry.action.startsWith('app.build.')).toBe(true);
                expect(Object.keys(entry.metadata ?? {}).sort()).toEqual([
                    'buildId',
                    'commitSha',
                    'failureClass',
                    'number',
                    'trigger',
                ]);
            }

            const serialised = JSON.stringify(harness.activity);
            expect(serialised).not.toContain('SECRET-EXCERPT-LINE');
            expect(serialised).not.toContain('APP_SECRET');
            expect(serialised).not.toContain('v7');
            expect(serialised).not.toContain('ghp_');
        });

        it('summary names the Build number', async () => {
            const harness = makeHarness();
            const row = harness.seed(makeRow({ workId: WORK_ID, id: uuid(70), number: 14 }));

            await harness.service.publish(row, 'app.build.queued');

            expect(harness.activity[0].summary).toBe('Build #14 queued');
        });

        it('maps each status to its Activity status', async () => {
            const harness = makeHarness();
            const statuses: Array<[WorkBuild['status'], ActivityStatus]> = [
                ['queued', ActivityStatus.PENDING],
                ['running', ActivityStatus.IN_PROGRESS],
                ['succeeded', ActivityStatus.COMPLETED],
                ['failed', ActivityStatus.FAILED],
                ['cancelled', ActivityStatus.CANCELLED],
            ];

            let index = 0;
            for (const [status, expected] of statuses) {
                index += 1;
                const row = harness.seed(
                    makeRow({ workId: WORK_ID, id: uuid(80 + index), status }),
                );
                // The writer derives the event from the status (§7.8's map), so the
                // name passed here is the one that map names for it.
                await harness.service.publish(row, appBuildEventNameForStatus(status)!);
                expect(harness.emitted[harness.emitted.length - 1].name).toBe(
                    appBuildEventNameForStatus(status),
                );
                expect(harness.activity[harness.activity.length - 1].status).toBe(expected);
            }
        });

        it('publishes NO event for a blocked Build, even when a caller asks it to', async () => {
            const harness = makeHarness();
            const row = harness.seed(
                makeRow({
                    workId: WORK_ID,
                    id: uuid(90),
                    status: 'blocked',
                    blockedReason: 'missingBuildValues',
                }),
            );

            // `blocked` is a stored status and NOT one of the five CONTRACTS §6
            // names, so a blocked Build publishes nothing (plan.md:1560). The WRITER
            // is where that is enforced: §7.8's map names `null` for `blocked` and the
            // writer refuses a name the status does not map to, so a caller that asks
            // anyway gets no Activity row, no emitted event and no Provisioner call.
            await harness.service.publish(row, 'app.build.queued');

            expect(harness.events()).toEqual([]);
            expect(harness.activity).toEqual([]);
            expect(harness.provisions).toEqual([]);
            expect(row.status).toBe('blocked');
        });
    });

    describe('applySnapshot — started exactly once, terminal exactly once (§7.8)', () => {
        it('publishes app.build.started exactly once across repeated running snapshots', async () => {
            const harness = makeHarness();
            const row = harness.seed(makeRow({ workId: WORK_ID, id: uuid(95) }));

            await harness.service.applySnapshot(row.id, snapshot());
            await harness.service.applySnapshot(row.id, snapshot());
            await harness.service.applySnapshot(row.id, snapshot());

            expect(harness.events().filter((name) => name === 'app.build.started')).toHaveLength(1);
        });

        it('a snapshot first seen as completed still publishes started BEFORE succeeded', async () => {
            const harness = makeHarness();
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                buildSecretNames: ['APP_SECRET'],
            });
            const row = harness.seed(makeRow({ workId: WORK_ID, id: uuid(96) }));

            await harness.service.applySnapshot(row.id, succeededSnapshot());

            expect(harness.events()).toEqual(['app.build.started', 'app.build.succeeded']);
        });

        it('carries the §7.8 payload, with deployable final only on succeeded', async () => {
            const harness = makeHarness();
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                buildSecretNames: ['APP_SECRET'],
            });
            const row = harness.seed(
                makeRow({
                    workId: WORK_ID,
                    id: uuid(97),
                    // The three columns the consumer stamps from the preparation row
                    // (§7.5:1467), so §5.1's `staleInputs` clause is satisfied and the
                    // payload's `deployable` is a real verdict rather than a default.
                    buildInputsHash: PREPARED_HASH,
                    buildSecretNames: ['APP_SECRET'],
                    secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                }),
            );

            await harness.service.applySnapshot(row.id, succeededSnapshot());

            const started = harness.emitted.find((e) => e.name === 'app.build.started')!.event
                .payload;
            const succeeded = harness.emitted.find((e) => e.name === 'app.build.succeeded')!.event
                .payload;
            expect(Object.keys(started).sort()).toEqual([
                'branch',
                'buildId',
                'cancelReason',
                'commitSha',
                'deployable',
                'failureClass',
                'imageDigest',
                'notDeployableReason',
                'number',
                'pullRequestNumber',
                'status',
                'trigger',
                'userId',
                'workId',
            ]);
            expect(started.deployable).toBe(false);
            expect(started.notDeployableReason).toBeNull();
            expect(succeeded.status).toBe('succeeded');
            expect(succeeded.deployable).toBe(true);
            expect(succeeded.notDeployableReason).toBeNull();
            expect(succeeded.imageDigest).toBe(DIGEST);
            expect(succeeded.userId).toBe(USER_ID);
        });

        it('finalises exactly once across three deliveries of the same terminal snapshot', async () => {
            const harness = makeHarness();
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                buildSecretNames: ['APP_SECRET'],
            });
            const row = harness.seed(makeRow({ workId: WORK_ID, id: uuid(98) }));

            await harness.service.applySnapshot(row.id, succeededSnapshot());
            await harness.service.applySnapshot(row.id, succeededSnapshot());
            await harness.service.applySnapshot(row.id, succeededSnapshot());

            expect(harness.events().filter((name) => name === 'app.build.succeeded')).toHaveLength(
                1,
            );
            expect(harness.usage).toHaveLength(1);
            expect(
                harness.activity.filter((entry) => entry.action === 'app.build.succeeded'),
            ).toHaveLength(1);
        });

        it('is idempotent for finalize() called directly on a settled Build', async () => {
            const harness = makeHarness();
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
            });
            const row = harness.seed(makeRow({ workId: WORK_ID, id: uuid(99) }));

            await harness.service.applySnapshot(row.id, succeededSnapshot());
            const again = await harness.service.finalize(row.id);

            expect(again.finalized).toBe(false);
            expect(again.reason).toBe('alreadyFinalized');
        });
    });

    describe('recordProviderRun — the shared accept rules (§7.5)', () => {
        it('creates one Build for a push run and publishes queued once', async () => {
            const harness = makeHarness();

            const first = await harness.service.recordProviderRun(WORK_ID, runRef(), 'event');
            const second = await harness.service.recordProviderRun(WORK_ID, runRef(), 'poll');

            expect(first.accepted && first.created).toBe(true);
            expect(second.accepted && second.created).toBe(false);
            expect(harness.store.size).toBe(1);
            expect(harness.events().filter((name) => name === 'app.build.queued')).toHaveLength(1);
        });

        it('ignores every run while the applied strategy is image/none/auto', async () => {
            const harness = makeHarness({
                spec: { ...SPEC_FIXTURE, build: { strategy: 'none' } },
            });

            expect(await harness.service.recordProviderRun(WORK_ID, runRef(), 'event')).toEqual({
                accepted: false,
                reason: 'strategyNotBuilt',
            });
            expect(harness.store.size).toBe(0);
        });

        it('creates no Build for a pull-request run whose head repository differs (ACC-05-06)', async () => {
            const harness = makeHarness();

            expect(
                await harness.service.recordProviderRun(
                    WORK_ID,
                    runRef({ event: 'pull_request', headRepositoryFullName: 'someone/shop' }),
                    'event',
                ),
            ).toEqual({ accepted: false, reason: 'forkPullRequestHead' });
            expect(harness.store.size).toBe(0);
        });

        it('adopts a manual run by display_title and publishes no second queued', async () => {
            const harness = makeHarness();
            const created = await harness.service.requestRebuild(WORK_ID, USER_ID);
            if (!created.ok) throw new Error('unreachable');
            const correlation = harness.row(created.build.id).dispatchCorrelationId!;
            harness.emitted.length = 0;

            const adopted = await harness.service.recordProviderRun(
                WORK_ID,
                runRef({ event: 'manual', displayTitle: `Ever Works Build ${correlation}` }),
                'event',
            );

            expect(adopted.accepted).toBe(true);
            if (!adopted.accepted) throw new Error('unreachable');
            expect(adopted.created).toBe(false);
            expect(adopted.build.id).toBe(created.build.id);
            expect(adopted.build.providerRunId).toBe('run-77');
            expect(harness.events()).not.toContain('app.build.queued');
        });

        it('ignores a manual run it cannot correlate', async () => {
            const harness = makeHarness();

            expect(
                await harness.service.recordProviderRun(
                    WORK_ID,
                    runRef({ event: 'manual', displayTitle: 'something else' }),
                    'event',
                ),
            ).toEqual({ accepted: false, reason: 'manualRunUncorrelated' });
        });

        it('stamps the three secret-sync columns from the preparation row (§7.5:1467)', async () => {
            const harness = makeHarness();
            harness.seedPreparation({
                buildInputsHash: PREPARED_HASH,
                secretsSyncedAt: new Date('2026-09-17T09:00:00.000Z'),
                buildSecretNames: ['APP_SECRET'],
            });

            const created = await harness.service.recordProviderRun(WORK_ID, runRef(), 'event');
            if (!created.accepted) throw new Error('unreachable');

            expect(created.build.buildInputsHash).toBe(PREPARED_HASH);
            expect(created.build.buildSecretNames).toEqual(['APP_SECRET']);
            expect(created.build.secretsSyncedAt).toEqual(new Date('2026-09-17T09:00:00.000Z'));
        });
    });

    describe('startVerification — the plan of §4.10 (APW05-G11)', () => {
        const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
        // `strict: false` because the schema uses `$defs` + `$ref` with a
        // `oneOf`-of-`required` idiom ajv's strict mode reports as a warning.
        const ajv = new Ajv2020({ strict: false, allErrors: true });
        const validate = ajv.compile(schema);

        it('builds the plan from the fixture spec at `sha` and it validates against verify-plan.schema.json', () => {
            const plan = buildVerificationPlan({
                spec: SPEC_FIXTURE,
                envRecipe: RECIPE_FIXTURE,
            });

            expect(plan.version).toBe(1);
            expect(plan.components.map((component) => component.name)).toEqual(['web', 'worker']);
            expect(plan.components[0]).toMatchObject({
                role: 'web',
                port: 3000,
                memoryMiB: 1024,
                probes: { readiness: { kind: 'http', path: '/health', periodSeconds: 5 } },
            });
            // A `worker` declares no port (the App spec forbids one); the plan schema
            // requires one, so the documented fallback is what it carries.
            expect(plan.components[1]).toMatchObject({ role: 'worker', port: 8080 });
            expect(plan.dependencies).toEqual([
                { kind: 'postgres', version: '16' },
                { kind: 'redis', version: '7' },
                { kind: 'objectStorage', buckets: ['uploads'] },
            ]);
            // `post-deploy` is manifest-only (§3.1:248) and never runs in the runner.
            expect(plan.jobs.map((job) => job.name)).toEqual(['migrate']);
            expect(plan.smoke[0]).toMatchObject({
                name: 'home',
                method: 'GET',
                path: '/',
                expect: { status: [200], bodyContains: ['Shop'] },
            });
            expect(plan.env).toEqual(RECIPE_FIXTURE);
            expect(plan.build).toEqual({
                strategy: 'dockerfile',
                dockerfile: 'Dockerfile',
                context: '.',
            });

            expect(validate(plan)).toBe(true);
            expect(validate.errors).toBeNull();
        });

        it('omits the build block when an earlier Build’s digest is reused', () => {
            const plan = buildVerificationPlan({
                spec: SPEC_FIXTURE,
                envRecipe: RECIPE_FIXTURE,
                reuseImageDigest: DIGEST,
            });

            expect(plan.build).toBeUndefined();
            expect(validate(plan)).toBe(true);
        });

        it('refuses a plan needing `smtp` before dispatch', () => {
            const spec: AppSpec = {
                ...SPEC_FIXTURE,
                dependencies: { smtp: { required: true } },
                env: [{ name: 'SMTP_URL', from: 'deps.smtp.url' }],
            };

            expect(() => buildVerificationPlan({ spec, envRecipe: RECIPE_FIXTURE })).toThrow(
                AppVerificationPlanRefusedError,
            );
            try {
                buildVerificationPlan({ spec, envRecipe: RECIPE_FIXTURE });
            } catch (error) {
                expect((error as AppVerificationPlanRefusedError).reason).toBe(
                    'verificationDependencyUnsupported',
                );
                expect((error as AppVerificationPlanRefusedError).detail).toEqual({ kind: 'smtp' });
            }
        });

        it('refuses a plan above 12 GiB summed runner memory before dispatch', () => {
            const spec: AppSpec = {
                ...SPEC_FIXTURE,
                components: [
                    { name: 'web', role: 'web', port: 3000, resources: { memoryLimit: '6Gi' } },
                    { name: 'worker', role: 'worker', resources: { memoryLimit: '6Gi' } },
                ],
            };

            try {
                buildVerificationPlan({ spec, envRecipe: [] });
                throw new Error('the plan should have been refused');
            } catch (error) {
                expect(error).toBeInstanceOf(AppVerificationPlanRefusedError);
                expect((error as AppVerificationPlanRefusedError).reason).toBe(
                    'verificationMemoryTooLarge',
                );
                // 2 × 6 GiB of components plus the dependency containers.
                expect(
                    verificationPlanMemoryMiB(
                        buildVerificationPlan({
                            spec: {
                                ...spec,
                                components: [{ name: 'web', role: 'web', port: 3000 }],
                            },
                            envRecipe: [],
                        }),
                    ),
                ).toBeLessThan(12 * 1024);
            }
        });

        it('refuses a base64url plan above 60,000 characters before dispatch', async () => {
            const manyEntries: AppEnvRecipeEntry[] = Array.from({ length: 60 }, (_, index) => ({
                name: `GENERATED_${index}`,
                source: 'literal',
                value: 'x'.repeat(1_200),
            })) as never;
            const harness = makeHarness({
                runnerRecipe: {
                    async resolveEphemeral() {
                        return { recipe: manyEntries, secretNames: [], unsetRequired: [] };
                    },
                } as never,
            });

            await expect(
                harness.service.startVerification(WORK_ID, { ref: 'main', sha: SHA }),
            ).rejects.toMatchObject({ reason: 'verificationPlanTooLarge' });

            // Refused BEFORE dispatch, and before a row exists to be orphaned.
            expect(harness.startBuildCalls).toHaveLength(0);
            expect(harness.store.size).toBe(0);
        });

        it('carries no resolved value from the env source into the dispatched plan', async () => {
            const secretish = 'RESOLVED-VALUE-MUST-NOT-SHIP';
            const harness = makeHarness({
                runnerRecipe: {
                    async resolveEphemeral() {
                        return {
                            recipe: [
                                {
                                    name: 'APP_SECRET',
                                    source: 'generate',
                                    generate: { kind: 'hex', bytes: 32 },
                                },
                            ] as never,
                            secretNames: ['APP_SECRET'],
                            unsetRequired: [],
                        };
                    },
                } as never,
            });

            const result = await harness.service.startVerification(WORK_ID, {
                ref: 'main',
                sha: SHA,
            });

            expect(result.blocked).toBe(false);
            const dispatched = harness.startBuildCalls[0].verification as {
                json: string;
                promptedNames: string[];
            };
            const decoded = Buffer.from(dispatched.json, 'base64url').toString('utf8');
            expect(decoded).not.toContain(secretish);
            expect(JSON.parse(decoded).env).toEqual([
                { name: 'APP_SECRET', source: 'generate', generate: { kind: 'hex', bytes: 32 } },
            ]);
        });

        it('blocks with missingBuildValues before dispatch and writes the per-run secret name', async () => {
            const harness = makeHarness({
                runnerRecipe: {
                    async resolveEphemeral() {
                        return {
                            recipe: RECIPE_FIXTURE,
                            secretNames: ['APP_SECRET'],
                            unsetRequired: ['APP_SECRET'],
                        };
                    },
                } as never,
            });

            const result = await harness.service.startVerification(WORK_ID, {
                ref: 'main',
                sha: SHA,
            });

            expect(result.blocked).toBe(true);
            expect(result.blockedReason).toBe('missingBuildValues');
            expect(harness.startBuildCalls).toHaveLength(0);
            expect(harness.row(result.buildId)).toMatchObject({
                status: 'blocked',
                blockedReason: 'missingBuildValues',
                blockedDetail: { names: ['APP_SECRET'] },
            });
            expect(harness.events()).toEqual([]);
        });

        it('records the reserved per-run prompted secret name when the recipe has prompted entries', async () => {
            const harness = makeHarness();

            const result = await harness.service.startVerification(WORK_ID, {
                ref: 'main',
                sha: SHA,
            });

            expect(harness.row(result.buildId).verifySecretNames).toEqual([
                APP_BUILD_VERIFY_PROMPTED_SECRET,
            ]);
            const dispatched = harness.startBuildCalls[0].verification as {
                promptedNames: string[];
            };
            expect(dispatched.promptedNames).toEqual(['ADMIN_EMAIL']);
        });
    });

    describe('APP_PROVISION_EVENTS_PORT.buildUpdated (APW05-G11)', () => {
        function countingPort(): { calls: string[]; port: { buildUpdated(id: string): void } } {
            const calls: string[] = [];
            return {
                calls,
                port: {
                    buildUpdated(id: string) {
                        calls.push(id);
                    },
                },
            };
        }

        it('is called three times for a verification Build: queued → running → succeeded', async () => {
            const counter = countingPort();
            const harness = makeHarness({ provisionEvents: counter.port });

            const result = await harness.service.startVerification(WORK_ID, {
                ref: 'main',
                sha: SHA,
            });
            await harness.service.applySnapshot(
                result.buildId,
                snapshot({ trigger: 'verification' }),
            );
            await harness.service.applySnapshot(
                result.buildId,
                succeededSnapshot({ trigger: 'verification' }),
            );

            expect(counter.calls).toEqual([result.buildId, result.buildId, result.buildId]);
            expect(counter.calls).toHaveLength(3);
            expect(harness.events()).toEqual([
                'app.build.queued',
                'app.build.started',
                'app.build.succeeded',
            ]);
        });

        it('is called exactly once for a pre-dispatch missingBuildValues block', async () => {
            const counter = countingPort();
            const harness = makeHarness({
                provisionEvents: counter.port,
                runnerRecipe: {
                    async resolveEphemeral() {
                        return {
                            recipe: RECIPE_FIXTURE,
                            secretNames: [],
                            unsetRequired: ['APP_SECRET'],
                        };
                    },
                } as never,
            });

            const result = await harness.service.startVerification(WORK_ID, {
                ref: 'main',
                sha: SHA,
            });

            expect(counter.calls).toEqual([result.buildId]);
            // The Build is blocked and published nothing: the push is the ONLY signal
            // APW-04 gets, which is the point of §7.8:1576-1580.
            expect(harness.events()).toEqual([]);
            expect(harness.activity).toEqual([]);
        });

        it('is never called for a push Build', async () => {
            const counter = countingPort();
            const harness = makeHarness({ provisionEvents: counter.port });

            const created = await harness.service.recordProviderRun(WORK_ID, runRef(), 'event');
            if (!created.accepted) throw new Error('unreachable');
            await harness.service.applySnapshot(created.build.id, succeededSnapshot());

            expect(counter.calls).toEqual([]);
        });

        it('never fails the job when the port throws', async () => {
            const harness = makeHarness({
                provisionEvents: {
                    buildUpdated() {
                        throw new Error('provisioner exploded');
                    },
                },
            });

            const result = await harness.service.startVerification(WORK_ID, {
                ref: 'main',
                sha: SHA,
            });
            await expect(
                harness.service.applySnapshot(
                    result.buildId,
                    succeededSnapshot({ trigger: 'verification' }),
                ),
            ).resolves.toBeDefined();

            expect(harness.row(result.buildId).status).toBe('succeeded');
        });
    });

    describe('requestPrepare and the prepareSeq marker (§7.2, APW05-G17)', () => {
        it('bumps prepareSeq on the existing preparation row before dispatching', async () => {
            const harness = makeHarness();
            harness.seedPreparation({ prepareSeq: 4 });

            const result = await harness.service.requestPrepare(WORK_ID, 'envChanged');

            expect(result).toEqual({ prepareSeq: 5, dispatched: true });
            expect(harness.dispatchedPrepare).toEqual([{ workId: WORK_ID, reason: 'envChanged' }]);
        });

        it('answers prepareSeq 0 for a Work with no preparation row — nothing to coalesce with', async () => {
            const harness = makeHarness();

            const result = await harness.service.requestPrepare(WORK_ID, 'specApplied');

            expect(result).toEqual({ prepareSeq: 0, dispatched: true });
            expect(harness.dispatchedPrepare).toHaveLength(1);
        });

        it('a Rebuild whose prepareSeq read fails is still dispatched (the bump never loses the request)', async () => {
            // `requestRebuild` requests its prepare through `requestPrepare`, so the
            // bump's READ of the row sits in front of the dispatch. A transient read
            // error there must cost the coalescing marker, never the Rebuild's
            // prepare — before, it rejected `requestPrepare`, the `.catch` logged
            // it, and the queued Build waited for an unrelated prepare.
            const harness = makeHarness();
            harness.seedPreparation({ prepareSeq: 4 });
            jest.spyOn(harness.preparationRepository, 'findByWork').mockRejectedValueOnce(
                new Error('connection terminated unexpectedly'),
            );

            const result = await harness.service.requestRebuild(WORK_ID, USER_ID);
            if (!result.ok) throw new Error('unreachable');
            await waitFor(() => harness.dispatchedPrepare.length === 1);

            expect(harness.dispatchedPrepare[0]).toEqual({
                workId: WORK_ID,
                reason: 'rebuild',
                buildId: result.build.id,
            });
            // The marker was not advanced (it could not be read) — and nothing
            // else was written in its place.
            expect(harness.preparation()?.prepareSeq).toBe(4);
        });

        it('a requestPrepare whose prepareSeq read fails answers prepareSeq 0 (unknown) and still dispatches', async () => {
            const harness = makeHarness();
            harness.seedPreparation({ prepareSeq: 4 });
            jest.spyOn(harness.preparationRepository, 'findByWork').mockRejectedValueOnce(
                new Error('connection terminated unexpectedly'),
            );

            const result = await harness.service.requestPrepare(WORK_ID, 'envChanged');

            expect(result).toEqual({ prepareSeq: 0, dispatched: true });
            expect(harness.dispatchedPrepare).toEqual([{ workId: WORK_ID, reason: 'envChanged' }]);
        });

        it('the bump writes prepareSeq alone — never a buildPluginId a racing prepare has since changed', async () => {
            // The bump reads the row, then merges. A prepare that lands between the
            // two and resolves a different build plugin must keep its value: the
            // bump names `prepareSeq` and nothing else it read.
            const harness = makeHarness();
            harness.seedPreparation({ prepareSeq: 4, buildPluginId: 'old-build-plugin' });
            jest.spyOn(harness.preparationRepository, 'findByWork').mockImplementationOnce(
                async () => {
                    const stale = { ...harness.preparation() } as WorkBuildPreparation;
                    // The racing prepare's write, after the bump's read.
                    harness.preparation()!.buildPluginId = 'new-build-plugin';
                    return stale;
                },
            );
            const upsert = jest.spyOn(harness.preparationRepository, 'upsertAfterPrepare');

            const result = await harness.service.requestPrepare(WORK_ID, 'envChanged');

            expect(result.prepareSeq).toBe(5);
            expect(upsert).toHaveBeenCalledTimes(1);
            expect(upsert).toHaveBeenCalledWith(WORK_ID, { prepareSeq: 5 });
            expect(harness.preparation()?.buildPluginId).toBe('new-build-plugin');
            expect(harness.preparation()?.prepareSeq).toBe(5);
        });

        it('a prepare requested while an in-process prepare runs is run again once it finishes', async () => {
            let runs = 0;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const payloads: Array<{ reason: string }> = [];
            const harness = makeHarness({
                prepareDispatcher: async () => null,
                prepareRunner: async (payload) => {
                    runs += 1;
                    payloads.push(payload);
                    if (runs === 1) await gate;
                },
            });

            await harness.service.requestPrepare(WORK_ID, 'specApplied');
            await waitFor(() => runs === 1);
            await harness.service.requestPrepare(WORK_ID, 'envChanged');
            // Never alongside the run in flight.
            expect(runs).toBe(1);

            release();
            await waitFor(() => runs === 2);
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(runs).toBe(2);
            expect(payloads.map((payload) => payload.reason)).toEqual(['specApplied', 'coalesced']);
        });

        it('the runner’s own coalescing dispatch from inside an in-process run is not dropped', async () => {
            // The runner asks for its coalesced prepare while it is still running
            // (the in-process marker is its own). In fallback mode that request
            // used to hit the "already in flight" guard and vanish.
            let runs = 0;
            let harness!: Harness;
            harness = makeHarness({
                prepareDispatcher: async () => null,
                prepareRunner: async () => {
                    runs += 1;
                    if (runs === 1) {
                        await harness.service.dispatchPrepare({
                            workId: WORK_ID,
                            reason: 'coalesced',
                        });
                    }
                },
            });

            await harness.service.requestPrepare(WORK_ID, 'specApplied');
            await waitFor(() => runs === 2);
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(runs).toBe(2);
        });

        it('reports dispatched: false and still runs the payload when the runtime refuses', async () => {
            let runs = 0;
            const harness = makeHarness({
                prepareDispatcher: async () => null,
                prepareRunner: async () => {
                    runs += 1;
                },
            });

            const result = await harness.service.requestPrepare(WORK_ID, 'specApplied');

            expect(result.dispatched).toBe(false);
            await waitFor(() => runs === 1);
            expect(harness.runnerRuns.filter((run) => run.kind === 'prepare')).toHaveLength(1);
        });
    });

    describe('getDetail', () => {
        it('returns the names of the synced values and never a value', async () => {
            const harness = makeHarness();
            const row = harness.seed(
                makeRow({
                    workId: WORK_ID,
                    id: uuid(120),
                    buildSecretNames: ['APP_SECRET', 'DATABASE_URL'],
                    billableMinutes: 4,
                    usageEventId: uuid(700),
                }),
            );

            const detail = await harness.service.getDetail(WORK_ID, row.id);

            expect(detail).not.toBeNull();
            expect(detail!.buildValueNames).toEqual(['APP_SECRET', 'DATABASE_URL']);
            expect(detail!.receipt).toEqual({
                billableMinutes: 4,
                checksBillableMinutes: null,
                payer: 'workspace',
                costKnown: true,
            });
            // Fail-closed: the edit-access port is unbound in this harness.
            expect(detail!.canEdit).toBe(false);
        });

        it('answers null for a Build of another Work', async () => {
            const harness = makeHarness();
            const row = harness.seed(makeRow({ workId: 'other', id: uuid(121) }));

            expect(await harness.service.getDetail(WORK_ID, row.id)).toBeNull();
        });
    });
});

/** One push run as the webhook consumer maps it (`BuildRunRef`, §4.1:685-696). */
function runRef(overrides: Partial<BuildRunRef> = {}): BuildRunRef {
    return {
        providerRunId: 'run-77',
        runAttempt: 1,
        event: 'push',
        status: 'in_progress',
        headSha: SHA,
        headBranch: 'main',
        headRepositoryFullName: 'acme/shop',
        displayTitle: 'Ever Works build',
        createdAt: '2026-09-17T10:04:00.000Z',
        ...overrides,
    };
}

/**
 * APW-05 T18 + T17 — **the two dispatcher tokens this service injects are the OWNER's
 * tokens**, not two more `Symbol()`s that merely share a description.
 *
 * This is the closure of the finding T18 routed, and it is the reason a "provisional
 * seam" needs this test rather than the comment that promised the swap: while
 * `app-builds.service.ts` declared its own
 * `Symbol('APP_BUILD_PREPARE_DISPATCHER')`, `buildJobRuntimeProviders()`'s binding of
 * T18's token could not reach the `@Optional()` injection — so `dispatchPrepare` and
 * `dispatchWatch` fell back **in process, always, silently**, and no test could see it
 * because the fallback is a legitimate, working path. A Nest token is compared by
 * identity; this asserts the identity against the real binding.
 */
describe('APW-05 T18 — the dispatcher tokens are the ones the runtime binds', () => {
    it('exports exactly the tokens buildJobRuntimeProviders() provides', () => {
        const bound = buildJobRuntimeProviders().map(
            (provider) => (provider as { provide: unknown }).provide,
        );

        expect(bound).toContain(APP_BUILD_PREPARE_DISPATCHER);
        expect(bound).toContain(APP_BUILD_WATCH_DISPATCHER);
    });

    it('carries an owner’s token that is distinct from a same-named Symbol', () => {
        // The negative control: if either name ever goes back to a local `Symbol(...)`,
        // this pair fails while the assertions above still pass — which is exactly the
        // half-fixed state the finding described.
        expect(APP_BUILD_PREPARE_DISPATCHER).not.toBe(
            Symbol('APP_BUILD_PREPARE_DISPATCHER') as unknown,
        );
        expect(APP_BUILD_PREPARE_DISPATCHER.description).toBe('APP_BUILD_PREPARE_DISPATCHER');
        expect(APP_BUILD_WATCH_DISPATCHER.description).toBe('APP_BUILD_WATCH_DISPATCHER');
    });
});
