// APW-01 T12/T13 — the two sibling modules `AppWorksModule` now imports (for the
// create path's `WorkRepository` and its git/deploy facades) pull in the whole
// TypeORM + facade + plugin-registry tree, which this spec's own DataSource does not
// need. They are shelled here, exactly as `CommunityPrModule`'s spec shells its two,
// so the wiring assertion below stays a test of THIS module's metadata and of the
// tokens it can mint itself.
jest.mock('../../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
// 2026-09-26 — `AppWorksModule` also imports the Activity, notification and Task
// modules its services inject (see its "bound by IMPORT" section). They are shelled
// for the reason the two above are: this is a bare-graph test of THIS module's own
// wiring, and every one of those collaborators is `@Optional()`.
// `app-works.module.graph.spec.ts` composes all of them for real.
jest.mock('../../activity-log/activity-log.module', () => ({
    ActivityLogModule: class ActivityLogModule {},
}));
jest.mock('../../notifications/notifications.module', () => ({
    NotificationsModule: class NotificationsModule {},
}));
jest.mock('../../tasks-domain/tasks.module', () => ({
    TasksDomainModule: class TasksDomainModule {},
}));

import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GitProviderRequestError } from '@ever-works/plugin';
import {
    APP_UPSTREAM_CONFLICT_LABEL_PREFIX,
    APP_UPSTREAM_SYNC_MANUAL_PER_HOUR,
} from '@ever-works/contracts';
import { ENTITIES } from '../../database/_entities-inventory';
import { ownershipStamp, type OwnershipScope } from '../../database/ownership-scope';
import { TaskRepository } from '../../database/repositories/task.repository';
import { WorkMemberRepository } from '../../database/repositories/work-member.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { WorkUpstreamStateRepository } from '../../database/repositories/work-upstream-state.repository';
import { Task, TaskStatus } from '../../entities/task.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { Work } from '../../entities/work.entity';
import { WorkUpstreamState } from '../../entities/work-upstream-state.entity';
import { NoGitCredentialsError } from '../../facades/git.facade';
import { AppWorksModule } from '../app-works.module';
import { DistributedTaskLockService } from '../../cache/distributed-task-lock.service';
import { APP_FORK_READY_HANDLER } from '../app-fork-ready-handler.port';
import {
    APP_FORK_READINESS_DISPATCHER,
    APP_UPSTREAM_SYNC_DISPATCHER,
    APP_WORK_AGENT_RESOLVER,
    AppUpstreamRefusalError,
    AppUpstreamStateService,
    UPSTREAM_SYNC_LOCK_KEY_PREFIX,
    isAppUpstreamRefusalError,
} from '../app-upstream-state.service';

/**
 * APW-02 T23 — `AppUpstreamStateService`, against a real database and real
 * repositories.
 *
 * The state row is the epic's whole memory (plan §3.1) and this service is its only
 * writer, so the row is exercised for real: an in-memory better-sqlite3 DataSource with
 * the production entity set (`work-upstream-states.repository.spec.ts` sets the same
 * baseline), the real `WorkUpstreamStateRepository`, `WorkRepository`,
 * `WorkMemberRepository` and `TaskRepository`. What is faked is what the service does not
 * own — the git facade, the Tasks/chat services, the Activity log, notifications, the
 * distributed lock and the three tokens whose owner tasks have not landed (see the
 * service's "provisional seams" block).
 *
 * That split is the point of the spec: **the five open Task statuses of plan §6.5 are the
 * real repository's filter**, not a stand-in, and "a Task in `done` is not reused" is
 * therefore asserted against the SQL production runs — the label match is the real
 * case-insensitive JSON-token LIKE (`task.repository.ts:286`).
 *
 * Every uuid below is obviously synthetic. Times are real (`Date.now()`), because the
 * service's own windows are rolling-hour comparisons and a frozen clock would assert
 * arithmetic instead of behaviour; nothing here is sensitive to a second's drift.
 *
 * Acceptance criteria: ACC-02-04, ACC-02-05, ACC-02-06, ACC-02-11, ACC-02-21 (the rows
 * that name this spec), plus every error code of plan §4.1 and §6.3 step 8's events.
 */

const OWNER = '11111111-1111-4111-8111-111111111101';
const OTHER_USER = '11111111-1111-4111-8111-111111111102';
const MEMBER = '11111111-1111-4111-8111-111111111103';
const WORK_ID = '22222222-2222-4222-8222-222222222201';
const PLAIN_WORK_ID = '22222222-2222-4222-8222-222222222202';
const MISSING_WORK_ID = '22222222-2222-4222-8222-2222222222ff';
/** The Tenant and Organization an org-scoped App Work belongs to (AW-1). */
const TENANT_ID = '33333333-3333-4333-8333-333333333301';
const ORG_ID = '44444444-4444-4444-8444-444444444401';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';

/** The five open statuses of plan §6.5 — `TASK_BOARD_STATUSES` minus the two terminal ones. */
const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];

describe('AppUpstreamStateService', () => {
    let dataSource: DataSource;
    let states: WorkUpstreamStateRepository;
    let works: WorkRepository;
    let members: WorkMemberRepository;
    let taskRepository: TaskRepository;

    /** The faked collaborators, re-created for every test. */
    interface Doubles {
        git: {
            getRepository: jest.Mock;
            getPullRequestFiles: jest.Mock;
            /** T43's read — the setup pull request follow-through. */
            getPullRequestStatus: jest.Mock;
        };
        tasks: { create: jest.Mock };
        taskChat: { post: jest.Mock };
        activity: { log: jest.Mock };
        notifications: { create: jest.Mock };
        locks: { isLocked: jest.Mock };
        resolver: { resolve: jest.Mock } | undefined;
        readinessDispatcher: { dispatch: jest.Mock } | undefined;
        syncDispatcher: { dispatch: jest.Mock } | undefined;
    }

    let doubles: Doubles;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // The owning User row is not what is under test — the Work, its state row and its
        // Tasks are — and `works.userId` carries a real FK to `users.id`. The FK itself is
        // asserted where it belongs (the migration specs); here it would only force a User
        // fixture onto every case. Same baseline as `work-upstream-state.repository.spec.ts`.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        states = new WorkUpstreamStateRepository(dataSource.getRepository(WorkUpstreamState));
        works = new WorkRepository(dataSource.getRepository(Work));
        members = new WorkMemberRepository(dataSource.getRepository(WorkMember));
        taskRepository = new TaskRepository(dataSource.getRepository(Task));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(Task).clear();
        await dataSource.getRepository(WorkMember).clear();
        await dataSource.getRepository(WorkUpstreamState).clear();
        await dataSource.getRepository(Work).clear();

        doubles = {
            git: {
                getRepository: jest.fn().mockResolvedValue({ empty: false, defaultBranch: 'main' }),
                getPullRequestFiles: jest.fn().mockResolvedValue([]),
                // Default: still open. Each test overrides what it is about.
                getPullRequestStatus: jest
                    .fn()
                    .mockResolvedValue({ number: 5, state: 'open', merged: false }),
            },
            tasks: {
                create: jest
                    .fn()
                    .mockImplementation(
                        async (_userId: string, input: Record<string, unknown>) => ({
                            id: 'created-task-1',
                            agentId: input.agentId ?? null,
                        }),
                    ),
            },
            taskChat: { post: jest.fn().mockResolvedValue({ id: 'message-1' }) },
            activity: { log: jest.fn().mockResolvedValue({ id: 'activity-1' }) },
            notifications: { create: jest.fn().mockResolvedValue({ id: 'notification-1' }) },
            locks: { isLocked: jest.fn().mockResolvedValue(false) },
            resolver: { resolve: jest.fn().mockResolvedValue(null) },
            readinessDispatcher: { dispatch: jest.fn().mockResolvedValue('run-readiness-1') },
            syncDispatcher: { dispatch: jest.fn().mockResolvedValue('run-sync-1') },
        };
    });

    /**
     * The service, wired by hand with the doubles. Optional collaborators are passed
     * positionally (the service documents that a caller may pass a prefix of them), and
     * the three provisional tokens are last.
     */
    function service(overrides: Partial<Doubles> = {}): AppUpstreamStateService {
        const d: Doubles = { ...doubles, ...overrides };
        return new AppUpstreamStateService(
            states,
            works,
            members,
            d.git as never,
            taskRepository,
            d.tasks as never,
            d.taskChat as never,
            d.activity as never,
            d.notifications as never,
            d.locks as never,
            d.resolver as never,
            d.readinessDispatcher as never,
            d.syncDispatcher as never,
        );
    }

    /** The Work behind the fixtures — kind `app`, owned by {@link OWNER}. */
    async function seedWork(id = WORK_ID, overrides: Partial<Work> = {}): Promise<Work> {
        const repository = dataSource.getRepository(Work);
        return repository.save(
            repository.create({
                id,
                name: 'Cloc',
                slug: `cloc-${id.slice(-4)}`,
                description: 'An app Work',
                userId: OWNER,
                kind: 'app',
                ...overrides,
            } as Partial<Work>),
        );
    }

    /** The state row, with the coordinates and readiness plan §3.1 defaults. */
    async function seedState(
        workId = WORK_ID,
        overrides: Partial<WorkUpstreamState> = {},
    ): Promise<WorkUpstreamState> {
        const repository = dataSource.getRepository(WorkUpstreamState);
        return repository.save(
            repository.create({
                workId,
                relation: 'fork',
                dataOwner: 'ever-works',
                dataRepo: 'cloc',
                dataDefaultBranch: 'main',
                upstreamOwner: 'cloc-co',
                upstreamRepo: 'cloc',
                upstreamDefaultBranch: 'main',
                readinessState: 'ready',
                readinessStartedAt: new Date(),
                readyAt: new Date(),
                ...overrides,
            }),
        );
    }

    /** A Task row, as the board would hold it. */
    async function seedTask(overrides: Partial<Task> & { slug: string }): Promise<Task> {
        const repository = dataSource.getRepository(Task);
        return repository.save(
            repository.create({
                userId: OWNER,
                workId: WORK_ID,
                title: 'A task',
                status: TaskStatus.IN_REVIEW,
                createdByType: 'user',
                createdById: OWNER,
                ...overrides,
            } as Partial<Task>),
        );
    }

    async function stored(workId = WORK_ID): Promise<WorkUpstreamState> {
        return dataSource.getRepository(WorkUpstreamState).findOneOrFail({ where: { workId } });
    }

    /** Every Activity entry the service recorded, in order. */
    function events(action?: string): Array<Record<string, any>> {
        const entries = doubles.activity.log.mock.calls.map((call) => call[0]);
        return action ? entries.filter((entry) => entry.action === action) : entries;
    }

    /** The refusal a rejected call threw, asserted to be this service's typed error. */
    async function refusalOf(promise: Promise<unknown>): Promise<AppUpstreamRefusalError> {
        try {
            await promise;
        } catch (error) {
            expect(isAppUpstreamRefusalError(error)).toBe(true);
            return error as AppUpstreamRefusalError;
        }
        throw new Error('expected the call to be refused');
    }

    // ── module + barrel + the port ───────────────────────────────────────────

    describe('wiring', () => {
        it('provides and exports the state service, and resolves it from the container', async () => {
            const metadata = (key: string): unknown[] =>
                (Reflect.getMetadata(key, AppWorksModule) as unknown[]) ?? [];
            expect(metadata('providers')).toContain(AppUpstreamStateService);
            expect(metadata('exports')).toContain(AppUpstreamStateService);
            expect(metadata('providers')).toContain(WorkUpstreamStateRepository);

            // The entity's repository and the create lock are the two tokens this
            // module cannot mint: the first comes from the DataSource the app opens,
            // the second needs the `CacheEntry` repository that the shelled
            // `DatabaseModule` would have supplied. With both bound, the container
            // resolves the service — which is what this assertion is for.
            const entityRepository = { findOne: jest.fn().mockResolvedValue(null) };
            const moduleRef = await Test.createTestingModule({ imports: [AppWorksModule] })
                .overrideProvider(getRepositoryToken(WorkUpstreamState))
                .useValue(entityRepository)
                .overrideProvider(DistributedTaskLockService)
                .useValue({ runExclusive: jest.fn(), isLocked: jest.fn() })
                .compile();

            expect(moduleRef.get(AppUpstreamStateService)).toBeInstanceOf(AppUpstreamStateService);
            await moduleRef.close();
        });

        it('exports the service, the ready-handler port and the three tokens from the barrel', () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const barrel = require('../index');
            expect(barrel.AppUpstreamStateService).toBe(AppUpstreamStateService);
            expect(typeof barrel.APP_FORK_READY_HANDLER).toBe('symbol');
            expect(typeof barrel.APP_WORK_AGENT_RESOLVER).toBe('symbol');
            expect(typeof barrel.APP_FORK_READINESS_DISPATCHER).toBe('symbol');
            expect(typeof barrel.APP_UPSTREAM_SYNC_DISPATCHER).toBe('symbol');
            expect(APP_FORK_READY_HANDLER.description).toBe('APP_FORK_READY_HANDLER');
        });
    });

    // ── §4.1 — the read ──────────────────────────────────────────────────────

    describe('get', () => {
        it('renders the whole card: coordinates, readiness, divergence, sync, actions and warnings', async () => {
            await seedWork();
            const now = Date.now();
            await seedState(WORK_ID, {
                readinessState: 'ready',
                readinessManualRetries: 1,
                readinessManualWindowAt: new Date(now - 60_000),
                setupPullRequestUrl: 'https://github.com/ever-works/cloc/pull/9',
                setupPullRequestNumber: 9,
                aheadBy: 3,
                behindBy: 12,
                divergenceComputedAt: new Date(now - 60_000),
                syncSchedule: '0 6 * * 1',
                nextSyncAt: new Date(now + 3_600_000),
                syncFinishedAt: new Date(now - 1_000),
                lastSyncResult: 'pull_request_opened',
                lastSyncReason: 'pull_request_opened',
                lastSyncCommitCount: 12,
                syncPullRequestNumber: 42,
                syncPullRequestUrl: 'https://github.com/ever-works/cloc/pull/42',
                conflictTaskId: '33333333-3333-4333-8333-333333333301',
                manualSyncCount: 2,
                manualSyncWindowAt: new Date(now - 60_000),
                consecutiveRateLimited: 3,
                rateLimitedUntil: new Date(now + 120_000),
                upstreamPreviousDefaultBranch: 'master',
                actionsState: 'clean',
                actionsDisabledWorkflows: [{ id: 7, path: '.github/workflows/ci.yml' }],
                actionsKeptWorkflows: [{ id: 8, path: '.github/workflows/build.yml' }],
                actionsCheckedAt: new Date(now - 5_000),
            });

            const body = await service().get(WORK_ID, OWNER);

            expect(body.workId).toBe(WORK_ID);
            expect(body.relation).toBe('fork');
            expect(body.dataRepository).toEqual({
                owner: 'ever-works',
                repo: 'cloc',
                url: 'https://github.com/ever-works/cloc',
                defaultBranch: 'main',
                status: 'available',
            });
            expect(body.upstream).toMatchObject({
                owner: 'cloc-co',
                repo: 'cloc',
                url: 'https://github.com/cloc-co/cloc',
                defaultBranch: 'main',
                previousDefaultBranch: 'master',
                status: 'unknown',
            });
            expect(body.readiness.state).toBe('ready');
            expect(body.readiness.setupPullRequestNumber).toBe(9);
            expect(body.readiness.manualRetriesLeft).toBe(2);
            expect(body.divergence).toMatchObject({ aheadBy: 3, behindBy: 12, stale: false });
            expect(body.sync).toMatchObject({
                schedule: '0 6 * * 1',
                running: false,
                lastResult: 'pull_request_opened',
                lastReason: 'pull_request_opened',
                lastCommitCount: 12,
                pullRequest: {
                    number: 42,
                    url: 'https://github.com/ever-works/cloc/pull/42',
                },
                conflictTaskId: '33333333-3333-4333-8333-333333333301',
                manualSyncsLeft: 4,
                rateLimitedPersistent: true,
            });
            expect(body.actions).toEqual({
                state: 'clean',
                disabled: [{ path: '.github/workflows/ci.yml' }],
                kept: [{ path: '.github/workflows/build.yml' }],
                checkedAt: new Date((await stored()).actionsCheckedAt as Date).toISOString(),
            });
            expect(body.warnings.map((warning) => warning.code)).toEqual([
                'rateLimited',
                'defaultBranchRenamed',
            ]);
        });

        it('marks a divergence reading older than the refresh window as stale (FR-46)', async () => {
            await seedWork();
            await seedState(WORK_ID, {
                aheadBy: 0,
                behindBy: 4,
                divergenceComputedAt: new Date(Date.now() - 900_000),
            });

            const body = await service().get(WORK_ID, OWNER);
            expect(body.divergence).toMatchObject({ behindBy: 4, stale: true });
        });

        it('renders a link App Work with no upstream and no sync at all (FR-44, FR-31)', async () => {
            await seedWork();
            await seedState(WORK_ID, {
                relation: 'link',
                upstreamOwner: null,
                upstreamRepo: null,
                upstreamDefaultBranch: null,
                actionsState: 'pending',
            });

            const body = await service().get(WORK_ID, OWNER);
            expect(body.upstream).toBeNull();
            expect(body.sync).toBeNull();
            expect(body.actions?.state).toBe('not_applicable');
            expect(body.warnings.map((warning) => warning.code)).toEqual([]);
        });

        it('reports the readiness reason through the closed union, keeping the provider code (FR-65)', async () => {
            await seedWork();
            await seedState(WORK_ID, {
                readinessState: 'failed',
                readinessReason: 'handler_failed:permission_missing',
            });

            const body = await service().get(WORK_ID, OWNER);
            expect(body.readiness.reason).toBe('handler_failed');
            expect(body.readiness.handlerReason).toEqual({ code: 'permission_missing' });
            expect(body.warnings.map((warning) => warning.code)).toEqual(['notReady']);
        });

        it("answers not found for another account's App Work (ACC-02-21)", async () => {
            await seedWork();
            await seedState();

            const error = await refusalOf(service().get(WORK_ID, OTHER_USER));
            expect(error.status).toBe(404);
            expect(error.code).toBe('not_found');
        });

        it('answers not found for a Work that is not kind `app` (ACC-02-21)', async () => {
            await seedWork(PLAIN_WORK_ID, { kind: 'directory', slug: 'plain' });
            await seedState(PLAIN_WORK_ID);

            const error = await refusalOf(service().get(PLAIN_WORK_ID, OWNER));
            expect(error.status).toBe(404);
            expect(error.code).toBe('not_found');
        });

        it('answers not found for a Work nobody can read, and for one with no state row', async () => {
            await seedWork();

            const unknown = await refusalOf(service().get(MISSING_WORK_ID, OWNER));
            expect(unknown.status).toBe(404);

            const noRow = await refusalOf(service().get(WORK_ID, OWNER));
            expect(noRow.code).toBe('not_found');
        });

        it('shows the Work to a member who is not the owner (FR-56)', async () => {
            await seedWork();
            await seedState();
            const memberRepository = dataSource.getRepository(WorkMember);
            await memberRepository.save(
                memberRepository.create({ workId: WORK_ID, userId: MEMBER }),
            );

            const body = await service().get(WORK_ID, MEMBER);
            expect(body.workId).toBe(WORK_ID);
        });

        it('fails closed to not found when no Work repository is bound', async () => {
            const unbound = new AppUpstreamStateService(states);
            const error = await refusalOf(unbound.get(WORK_ID, OWNER));
            expect(error.status).toBe(404);
        });
    });

    // ── §6.2 — readiness ─────────────────────────────────────────────────────

    describe('beginAttempt / probeReadiness (ACC-02-04)', () => {
        it('stamps the heartbeat and hands the job the relation and the coordinates', async () => {
            await seedWork();
            await seedState(WORK_ID, {
                readinessState: 'preparing',
                readyAt: null,
                copyPushedSha: SHA_A,
            });

            const attempt = await service().beginAttempt(WORK_ID, 1);

            expect(attempt).toMatchObject({
                found: true,
                ready: false,
                relation: 'fork',
                dataOwner: 'ever-works',
                dataRepo: 'cloc',
                dataDefaultBranch: 'main',
                upstreamOwner: 'cloc-co',
                upstreamRepo: 'cloc',
                copyPushedSha: SHA_A,
            });
            expect((await stored()).readinessHeartbeatAt).toBeInstanceOf(Date);
        });

        it('short-circuits a Work that is already ready (FR-22)', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'ready' });

            await expect(service().beginAttempt(WORK_ID, 2)).resolves.toMatchObject({
                found: true,
                ready: true,
            });
        });

        it('reports a missing state row rather than inventing one', async () => {
            await expect(service().beginAttempt(MISSING_WORK_ID, 1)).resolves.toMatchObject({
                found: false,
            });
        });

        it('stays preparing on an empty repository and becomes ready on a non-empty one', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const git = {
                ...doubles.git,
                getRepository: jest
                    .fn()
                    .mockResolvedValueOnce({ empty: true, defaultBranch: 'main' }),
            };
            const gitService = { getRepository: git.getRepository, getPullRequestFiles: jest.fn() };

            const empty = await service({ git: gitService as never }).probeReadiness(WORK_ID);
            expect(empty).toEqual({ status: 'preparing', empty: true });

            git.getRepository.mockResolvedValueOnce({ empty: false, defaultBranch: 'main' });
            const ready = await service({ git: gitService as never }).probeReadiness(WORK_ID);
            expect(ready).toEqual({ status: 'ready', empty: false });
        });

        it('reads a repository whose provider skips the emptiness probe but reports content as ready', async () => {
            // GitHub computes `empty` only when `size === 0`, so an ordinary fork reports
            // `empty: undefined` with a positive size — ready, or every Work would time out.
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const git = {
                getRepository: jest.fn().mockResolvedValue({ sizeKb: 51_200 }),
                getPullRequestFiles: jest.fn(),
            };

            await expect(
                service({ git: git as never }).probeReadiness(WORK_ID),
            ).resolves.toMatchObject({ status: 'ready', empty: null });
        });

        it('asks the facade with the Work-scoped credentials', async () => {
            await seedWork();
            await seedState();
            const git = {
                getRepository: jest.fn().mockResolvedValue({ empty: false }),
                getPullRequestFiles: jest.fn(),
            };

            await service({ git: git as never }).probeReadiness(WORK_ID);

            expect(git.getRepository).toHaveBeenCalledWith('ever-works', 'cloc', {
                userId: OWNER,
                providerId: 'github',
                workId: WORK_ID,
            });
        });

        it('keeps polling when the repository cannot be read yet, and classifies a dead credential (FR-20)', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });

            const git = {
                getRepository: jest.fn().mockResolvedValue(null),
                getPullRequestFiles: jest.fn(),
            };
            await expect(service({ git: git as never }).probeReadiness(WORK_ID)).resolves.toEqual({
                status: 'preparing',
                empty: null,
            });

            git.getRepository.mockRejectedValue(new NoGitCredentialsError('github', OWNER));
            await expect(
                service({ git: git as never }).probeReadiness(WORK_ID),
            ).resolves.toMatchObject({ status: 'access_revoked', reason: 'access_revoked' });

            git.getRepository.mockRejectedValue(new GitProviderRequestError('unauthorized', 401));
            await expect(
                service({ git: git as never }).probeReadiness(WORK_ID),
            ).resolves.toMatchObject({ status: 'access_revoked' });
        });

        it('hands a rate limit back with the instant to retry at (FR-50)', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const retryAt = new Date(Date.now() + 60_000).toISOString();
            const git = {
                getRepository: jest
                    .fn()
                    .mockRejectedValue(
                        new GitProviderRequestError('rate_limited', 403, { retryAt }),
                    ),
                getPullRequestFiles: jest.fn(),
            };

            await expect(
                service({ git: git as never }).probeReadiness(WORK_ID),
            ).resolves.toMatchObject({ status: 'rate_limited', retryAt });
        });

        it('names a missing facade as provider_unsupported instead of waiting out the deadline', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const unbound = new AppUpstreamStateService(states, works, members);

            await expect(unbound.probeReadiness(WORK_ID)).resolves.toMatchObject({
                status: 'failed',
                reason: 'provider_unsupported',
            });
        });

        it('remembers the pushed copy sha once (FR-21)', async () => {
            await seedWork();
            await seedState(WORK_ID, { copyPushedSha: null });

            await service().recordCopyPushed(WORK_ID, SHA_A);
            expect((await stored()).copyPushedSha).toBe(SHA_A);

            // Idempotent: the same head writes nothing more.
            await service().recordCopyPushed(WORK_ID, SHA_A);
            expect((await stored()).copyPushedSha).toBe(SHA_A);
        });
    });

    describe('markReady / timeout — one event per transition', () => {
        it('stamps nextSyncAt in the same write as readyAt (plan §6.2 step 5)', async () => {
            // The regression this pins: `nextSyncAt` NULL is never `<= now`, so a ready fork that
            // is not stamped here is never selected by the dispatcher — its first scheduled sync
            // would not fire at all. Measured against the clock rather than against a constant: the
            // helper adds this Work's stable jitter to a real cron slot, so the assertion is
            // "some future instant", which is what the schedule means.
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const state = service();

            await state.markReady(WORK_ID, { result: 'initialized' });

            const stamped = await stored();
            expect(stamped.nextSyncAt).toBeInstanceOf(Date);
            expect((stamped.nextSyncAt as Date).getTime()).toBeGreaterThan(Date.now());
        });

        it('leaves a failed readiness unstamped — there is no repository to sync', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const state = service();

            await state.markReady(WORK_ID, { result: 'failed', reason: 'blueprint_apply_failed' });

            expect(await stored()).toMatchObject({ readinessState: 'failed', nextSyncAt: null });
        });

        it('emits app.fork.ready exactly once across repeated calls', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const state = service();

            const first = await state.markReady(WORK_ID, { result: 'initialized' });
            const second = await state.markReady(WORK_ID, { result: 'initialized' });

            expect(first.emitted).toBe(true);
            expect(second.emitted).toBe(false);
            expect(events('app.fork.ready')).toHaveLength(1);
            expect(events('app.fork.ready')[0]).toMatchObject({
                actionType: 'app_fork',
                status: 'completed',
                userId: OWNER,
                workId: WORK_ID,
            });
            expect((await stored()).readinessState).toBe('ready');
            expect((await stored()).readyAt).toBeInstanceOf(Date);
        });

        it('records waiting_for_setup_pr with the setup pull request, without a second event (FR-24a)', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const state = service();

            await state.markReady(WORK_ID, { result: 'initialized' });
            const followUp = await state.markReady(WORK_ID, {
                result: 'waiting_for_setup_pr',
                setupPullRequestUrl: 'https://github.com/ever-works/cloc/pull/5',
                setupPullRequestNumber: 5,
            });

            expect(followUp.state).toBe('waiting_for_setup_pr');
            expect(followUp.emitted).toBe(false);
            expect(events('app.fork.ready')).toHaveLength(1);
            expect(await stored()).toMatchObject({
                readinessState: 'waiting_for_setup_pr',
                setupPullRequestNumber: 5,
            });
        });

        it('records a failed outcome as handler_failed:<reason> (T23 port clause)', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });

            const resolution = await service().markReady(WORK_ID, {
                result: 'failed',
                reason: 'blueprint_apply_failed',
            });

            expect(resolution.state).toBe('failed');
            expect((await stored()).readinessReason).toBe('handler_failed:blueprint_apply_failed');
            expect(events('app.fork.ready')).toHaveLength(1);
            expect(events('app.fork.ready')[0].status).toBe('failed');
        });

        it('emits app.fork.timeout once per attempt — not once per call', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const state = service();

            const first = await state.timeout(WORK_ID, 1);
            const repeated = await state.timeout(WORK_ID, 1);
            expect(first.emitted).toBe(true);
            expect(repeated.emitted).toBe(false);
            expect(events('app.fork.timeout')).toHaveLength(1);
            expect(events('app.fork.timeout')[0]).toMatchObject({
                actionType: 'app_fork',
                status: 'failed',
                details: { attempt: 1 },
            });
            expect((await stored()).readinessReason).toBe('timed_out');

            // Try again is a NEW attempt, so its own timeout is its own event (ACC-02-05).
            await state.retryReadiness(WORK_ID, OWNER);
            const second = await state.timeout(WORK_ID, 2);
            expect(second.emitted).toBe(true);
            expect(events('app.fork.timeout')).toHaveLength(2);
        });

        it('reports nothing emitted when there is no row to move', async () => {
            await expect(service().timeout(MISSING_WORK_ID, 1)).resolves.toEqual({
                found: false,
                state: null,
                emitted: false,
            });
            await expect(service().fail(MISSING_WORK_ID, 'access_revoked')).resolves.toMatchObject({
                found: false,
                emitted: false,
            });
        });
    });

    // ── §4.1 — Try again (FR-19) ─────────────────────────────────────────────

    /**
     * FR-24a — the setup pull request follow-through (APW-02 T43).
     *
     * The row this is about rests in `waiting_for_setup_pr` on a pull request the platform
     * opened in the member's own repository. Before T43 nothing watched it, so a member who
     * merged (or closed) the setup pull request left the Work waiting for ever.
     */
    describe('checkSetupPullRequest (FR-24a, T43)', () => {
        /** A row exactly as the readiness handler's `waiting_for_setup_pr` outcome leaves it. */
        const seedWaiting = async (overrides: Record<string, unknown> = {}) => {
            await seedWork();
            await seedState(WORK_ID, {
                readinessState: 'waiting_for_setup_pr',
                setupPullRequestNumber: 5,
                setupPullRequestUrl: 'https://github.com/ever-works/cloc/pull/5',
                setupCheckedAt: null,
                readyAt: new Date(),
                ...overrides,
            });
        };

        it('leaves an open pull request waiting, and records only that it checked', async () => {
            await seedWaiting();
            doubles.git.getPullRequestStatus.mockResolvedValue({
                number: 5,
                state: 'open',
                merged: false,
            });

            const result = await service().checkSetupPullRequest(WORK_ID);

            expect(result).toMatchObject({ found: true, checked: true, status: 'open' });
            const row = await stored();
            expect(row.readinessState).toBe('waiting_for_setup_pr');
            expect(row.setupCheckedAt).toBeInstanceOf(Date);
            expect(doubles.readinessDispatcher?.dispatch).not.toHaveBeenCalled();
        });

        it('dispatches readiness once with reason setup_merged when the pull request merged', async () => {
            await seedWaiting();
            doubles.git.getPullRequestStatus.mockResolvedValue({
                number: 5,
                state: 'merged',
                merged: true,
            });

            const result = await service().checkSetupPullRequest(WORK_ID);

            expect(result).toMatchObject({ found: true, checked: true, status: 'merged' });
            expect(doubles.readinessDispatcher?.dispatch).toHaveBeenCalledTimes(1);
            expect(doubles.readinessDispatcher?.dispatch).toHaveBeenCalledWith({
                workId: WORK_ID,
                attempt: 1,
                reason: 'setup_merged',
            });
            // The row is put back to `preparing` *before* the queue is asked, exactly as
            // `retryReadiness` does, so the dispatched work is visible in the row.
            expect(await stored()).toMatchObject({
                readinessState: 'preparing',
                readinessReason: null,
                readinessDispatches: 0,
            });
        });

        it('fails the Work as setup_pull_request_closed when it was closed unmerged', async () => {
            await seedWaiting();
            doubles.git.getPullRequestStatus.mockResolvedValue({
                number: 5,
                state: 'closed',
                merged: false,
            });

            const result = await service().checkSetupPullRequest(WORK_ID);

            expect(result).toMatchObject({ checked: true, status: 'closed' });
            expect(await stored()).toMatchObject({
                readinessState: 'failed',
                readinessReason: 'setup_pull_request_closed',
            });
            expect(doubles.readinessDispatcher?.dispatch).not.toHaveBeenCalled();
        });

        it('leaves the row alone when the provider will not answer — never a lost setup', async () => {
            await seedWaiting();
            doubles.git.getPullRequestStatus.mockRejectedValue(new Error('scope withdrawn'));

            const result = await service().checkSetupPullRequest(WORK_ID);

            // `unknown` is a fifth answer and deliberately not a transition: a credential
            // problem is transient, and failing the Work here would turn "we could not read
            // GitHub this minute" into a setup the member never asked to abandon.
            expect(result).toMatchObject({ checked: true, status: 'unknown' });
            expect(await stored()).toMatchObject({
                readinessState: 'waiting_for_setup_pr',
                readinessReason: null,
            });
            expect(doubles.readinessDispatcher?.dispatch).not.toHaveBeenCalled();
        });

        it('treats a null status the same way — a pull request the provider cannot see', async () => {
            await seedWaiting();
            doubles.git.getPullRequestStatus.mockResolvedValue(null);

            expect(await service().checkSetupPullRequest(WORK_ID)).toMatchObject({
                checked: true,
                status: 'unknown',
            });
            expect(await stored()).toMatchObject({ readinessState: 'waiting_for_setup_pr' });
        });

        it('does nothing at all — not even a stamp — when the row is not waiting', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'ready', setupPullRequestNumber: 5 });

            const result = await service().checkSetupPullRequest(WORK_ID);

            expect(result).toMatchObject({ found: true, checked: false, status: 'not_waiting' });
            // A check that did not happen must not make the row look freshly checked: that
            // stamp is the rate limit for the on-view door.
            expect((await stored()).setupCheckedAt).toBeNull();
            expect(doubles.git.getPullRequestStatus).not.toHaveBeenCalled();
        });

        it('does nothing when there is no number to read', async () => {
            await seedWork();
            await seedState(WORK_ID, {
                readinessState: 'waiting_for_setup_pr',
                setupPullRequestNumber: null,
            });

            expect(await service().checkSetupPullRequest(WORK_ID)).toMatchObject({
                checked: false,
                status: 'not_waiting',
            });
            expect(doubles.git.getPullRequestStatus).not.toHaveBeenCalled();
        });

        it('reports not found for a Work with no state row', async () => {
            await seedWork();

            expect(await service().checkSetupPullRequest(MISSING_WORK_ID)).toEqual({
                found: false,
                checked: false,
                status: 'not_waiting',
            });
        });

        it('reads the member’s own credential and never passes workId to the facade (FR-43)', async () => {
            await seedWaiting();
            doubles.git.getPullRequestStatus.mockResolvedValue({
                number: 5,
                state: 'open',
                merged: false,
            });

            await service().checkSetupPullRequest(WORK_ID);

            // The setup pull request is in the member's repository and is theirs to read. Passing
            // `workId` in the facade options is what lets a platform or installation token answer
            // instead — the routed FR-43 finding — so this asserts its absence, not just the user.
            expect(doubles.git.getPullRequestStatus).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),
                5,
                { userId: OWNER, providerId: 'github' },
            );
            const options = doubles.git.getPullRequestStatus.mock.calls[0][3] as Record<
                string,
                unknown
            >;
            expect(Object.keys(options).sort()).toEqual(['providerId', 'userId']);
            expect(options.workId).toBeUndefined();
        });
    });

    describe('retryReadiness', () => {
        it('refuses a Work that is preparing or ready with not_retryable', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });

            const preparing = await refusalOf(service().retryReadiness(WORK_ID, OWNER));
            expect(preparing.status).toBe(409);
            expect(preparing.code).toBe('not_retryable');

            await states.update(WORK_ID, { readinessState: 'ready' });
            const ready = await refusalOf(service().retryReadiness(WORK_ID, OWNER));
            expect(ready.code).toBe('not_retryable');
        });

        it('resumes without a new fork, clears the reason and keeps the copy sha (ACC-02-05, ACC-02-06)', async () => {
            await seedWork();
            await seedState(WORK_ID, {
                readinessState: 'failed',
                readinessReason: 'access_revoked',
                copyPushedSha: SHA_B,
            });
            const state = service();

            await state.fail(WORK_ID, 'access_revoked');
            const accepted = await state.retryReadiness(WORK_ID, OWNER);

            expect(accepted).toEqual({ queued: true, runId: 'run-readiness-1' });
            expect(doubles.readinessDispatcher?.dispatch).toHaveBeenCalledWith({
                workId: WORK_ID,
                attempt: 1,
                reason: 'retry',
            });

            const row = await stored();
            expect(row.readinessState).toBe('preparing');
            expect(row.readinessReason).toBeNull();
            expect(row.readinessDispatches).toBe(0);
            expect(row.copyPushedSha).toBe(SHA_B);
            // Same coordinates: Try again never re-forks (ACC-02-05).
            expect(row).toMatchObject({
                dataOwner: 'ever-works',
                dataRepo: 'cloc',
                relation: 'fork',
            });
        });

        it('refuses the fourth attempt in the rolling hour with retry_limit_reached (ACC-02-05)', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });
            const state = service();

            // Three timeouts, three accepted retries — and the fourth timeout in the same hour.
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                await state.timeout(WORK_ID, attempt);
                await expect(state.retryReadiness(WORK_ID, OWNER)).resolves.toMatchObject({
                    queued: true,
                });
            }
            await state.timeout(WORK_ID, 4);

            const error = await refusalOf(state.retryReadiness(WORK_ID, OWNER));
            expect(error.status).toBe(429);
            expect(error.code).toBe('retry_limit_reached');
            const retryAt = Date.parse(String(error.details?.retryAt));
            expect(Number.isNaN(retryAt)).toBe(false);
            expect(retryAt).toBeGreaterThan(Date.now());
        });

        it("answers not found for another account's Work (ACC-02-21)", async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'timed_out' });

            const error = await refusalOf(service().retryReadiness(WORK_ID, OTHER_USER));
            expect(error.status).toBe(404);
            expect(error.code).toBe('not_found');
        });

        it('queues nothing and still answers the 202 body when no dispatcher is bound', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'timed_out' });

            await expect(
                service({ readinessDispatcher: undefined }).retryReadiness(WORK_ID, OWNER),
            ).resolves.toEqual({ queued: true, runId: null });
        });
    });

    // ── §4.1 — Sync now (FR-33, FR-34) ───────────────────────────────────────

    describe('requestSync', () => {
        it('refuses a link App Work with no_upstream (422)', async () => {
            await seedWork();
            await seedState(WORK_ID, { relation: 'link' });

            const error = await refusalOf(service().requestSync(WORK_ID, OWNER));
            expect(error.status).toBe(422);
            expect(error.code).toBe('no_upstream');
        });

        it('refuses a Work that is not ready with not_ready (409)', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });

            const error = await refusalOf(service().requestSync(WORK_ID, OWNER));
            expect(error.status).toBe(409);
            expect(error.code).toBe('not_ready');
        });

        it('refuses a paused Work with sync_paused and the reason (409)', async () => {
            await seedWork();
            await seedState(WORK_ID, { upstreamStatus: 'archived' });

            const archived = await refusalOf(service().requestSync(WORK_ID, OWNER));
            expect(archived.status).toBe(409);
            expect(archived.code).toBe('sync_paused');
            expect(archived.details?.reason).toBe('upstream_archived');

            await states.update(WORK_ID, { upstreamStatus: 'unavailable' });
            expect((await refusalOf(service().requestSync(WORK_ID, OWNER))).details?.reason).toBe(
                'upstream_unavailable',
            );

            await states.update(WORK_ID, {
                upstreamStatus: 'available',
                dataRepositoryStatus: 'missing',
            });
            expect((await refusalOf(service().requestSync(WORK_ID, OWNER))).details?.reason).toBe(
                'data_repository_missing',
            );

            await states.update(WORK_ID, {
                dataRepositoryStatus: 'available',
                lastSyncResult: 'paused',
                lastSyncReason: 'too_large_for_private_copy',
            });
            const tooLarge = await refusalOf(service().requestSync(WORK_ID, OWNER));
            expect(tooLarge.code).toBe('sync_paused');
            expect(tooLarge.details?.reason).toBe('too_large_for_private_copy');
        });

        it('refuses while a sync holds the lock with sync_in_progress (409)', async () => {
            await seedWork();
            await seedState();

            const locked = await refusalOf(
                service({ locks: { isLocked: jest.fn().mockResolvedValue(true) } }).requestSync(
                    WORK_ID,
                    OWNER,
                ),
            );
            expect(locked.status).toBe(409);
            expect(locked.code).toBe('sync_in_progress');

            // The lock is the authority; the row is the fallback when it is unbound.
            expect(doubles.locks.isLocked).not.toHaveBeenCalled();
            await states.update(WORK_ID, { syncStartedAt: new Date(), syncFinishedAt: null });
            await states.update(WORK_ID, { syncStartedAt: new Date() });
            const running = await refusalOf(service().requestSync(WORK_ID, OWNER));
            expect(running.code).toBe('sync_in_progress');
        });

        it('asks the lock under the sync key of this Work', async () => {
            await seedWork();
            await seedState();

            await service().requestSync(WORK_ID, OWNER);
            expect(doubles.locks.isLocked).toHaveBeenCalledWith(
                `${UPSTREAM_SYNC_LOCK_KEY_PREFIX}${WORK_ID}`,
            );
        });

        it('refuses the seventh manual sync in the rolling hour with sync_limit_reached (429)', async () => {
            await seedWork();
            await seedState();
            const state = service();

            for (let call = 1; call <= APP_UPSTREAM_SYNC_MANUAL_PER_HOUR; call += 1) {
                await expect(state.requestSync(WORK_ID, OWNER)).resolves.toEqual({
                    queued: true,
                    runId: 'run-sync-1',
                });
            }

            const error = await refusalOf(state.requestSync(WORK_ID, OWNER));
            expect(error.status).toBe(429);
            expect(error.code).toBe('sync_limit_reached');
            expect(Date.parse(String(error.details?.retryAt))).toBeGreaterThan(Date.now());
            expect((await stored()).manualSyncCount).toBe(APP_UPSTREAM_SYNC_MANUAL_PER_HOUR);
        });

        it('works while the schedule is off, because nextSyncAt is not the pause signal (ACC-02-28)', async () => {
            await seedWork();
            await seedState(WORK_ID, { nextSyncAt: null, syncSchedule: null });

            await expect(service().requestSync(WORK_ID, OWNER)).resolves.toEqual({
                queued: true,
                runId: 'run-sync-1',
            });
            expect(doubles.syncDispatcher?.dispatch).toHaveBeenCalledWith({
                workId: WORK_ID,
                trigger: 'manual',
            });
        });

        it("answers not found for another account's Work (ACC-02-21)", async () => {
            await seedWork();
            await seedState();

            const error = await refusalOf(service().requestSync(WORK_ID, OTHER_USER));
            expect(error.status).toBe(404);
            expect(error.code).toBe('not_found');
        });
    });

    // ── §6.3 — the sync run's transitions ────────────────────────────────────

    describe('beginSync / finishSync', () => {
        it('claims the Work for a ready or waiting-for-setup Work and stamps the run', async () => {
            await seedWork();
            await seedState();

            const claimed = await service().beginSync(WORK_ID, 'schedule');
            expect(claimed.allowed).toBe(true);
            expect(claimed.startedAt).toEqual(expect.any(String));
            expect((await stored()).syncStartedAt).toBeInstanceOf(Date);

            await states.update(WORK_ID, { readinessState: 'waiting_for_setup_pr' });
            await states.update(WORK_ID, { syncFinishedAt: new Date() });
            await expect(service().beginSync(WORK_ID, 'manual')).resolves.toMatchObject({
                allowed: true,
            });
        });

        it('refuses to claim a Work that is not ready, or has no upstream, or does not exist', async () => {
            await seedWork();
            await seedState(WORK_ID, { readinessState: 'preparing', readyAt: null });

            await expect(service().beginSync(WORK_ID, 'schedule')).resolves.toMatchObject({
                allowed: false,
                reason: 'not_ready',
            });

            await states.update(WORK_ID, { readinessState: 'ready', relation: 'link' });
            await expect(service().beginSync(WORK_ID, 'schedule')).resolves.toMatchObject({
                allowed: false,
                reason: 'no_upstream',
            });

            await expect(service().beginSync(MISSING_WORK_ID, 'schedule')).resolves.toMatchObject({
                allowed: false,
                reason: 'not_found',
            });
        });

        it('refuses a second claim while the first run is still inside the lease', async () => {
            await seedWork();
            await seedState(WORK_ID, { syncStartedAt: new Date(), syncFinishedAt: null });

            await expect(service().beginSync(WORK_ID, 'schedule')).resolves.toMatchObject({
                allowed: false,
                reason: 'sync_in_progress',
            });
        });

        it('records a fast-forward and emits app.upstream.synced once per run', async () => {
            await seedWork();
            await seedState(WORK_ID, { syncStartedAt: new Date(), syncFinishedAt: null });
            const state = service();
            const run = {
                result: 'fast_forwarded' as const,
                reason: 'fast_forwarded',
                commits: 4,
                fromSha: SHA_A,
                toSha: SHA_B,
                trackedBranchChanged: true,
            };

            const first = await state.finishSync(WORK_ID, run);
            const repeat = await state.finishSync(WORK_ID, run);

            expect(first).toMatchObject({
                found: true,
                emitted: true,
                duplicate: false,
                trackedBranchChanged: true,
            });
            expect(repeat).toMatchObject({ emitted: false, duplicate: true });
            expect(events('app.upstream.synced')).toHaveLength(1);
            expect(events('app.upstream.synced')[0]).toMatchObject({
                actionType: 'app_upstream',
                action: 'app.upstream.synced',
                details: { result: 'fast_forwarded', commits: 4, fromSha: SHA_A, toSha: SHA_B },
            });
            expect(await stored()).toMatchObject({
                lastSyncResult: 'fast_forwarded',
                lastSyncReason: 'fast_forwarded',
                lastSyncCommitCount: 4,
                lastSyncedUpstreamSha: SHA_B,
                consecutiveRateLimited: 0,
            });

            // Upstream moving again is a new run with its own event.
            const third = await state.finishSync(WORK_ID, { ...run, toSha: SHA_A, commits: 5 });
            expect(third.emitted).toBe(true);
            expect(events('app.upstream.synced')).toHaveLength(2);
        });

        it('emits for the pull-request outcomes and stays silent for the rest', async () => {
            await seedWork();
            await seedState(WORK_ID);
            const state = service();

            await state.finishSync(WORK_ID, {
                result: 'pull_request_opened',
                reason: 'pull_request_opened',
                commits: 2,
                toSha: SHA_B,
                pullRequestNumber: 42,
                pullRequestUrl: 'https://github.com/ever-works/cloc/pull/42',
            });
            expect(events('app.upstream.synced')).toHaveLength(1);
            expect(events('app.upstream.synced')[0].details).toMatchObject({
                result: 'pull_request_opened',
                pullRequestNumber: 42,
            });
            expect(await stored()).toMatchObject({
                syncPullRequestNumber: 42,
                syncPullRequestUrl: 'https://github.com/ever-works/cloc/pull/42',
            });

            await state.finishSync(WORK_ID, {
                result: 'up_to_date',
                reason: 'up_to_date',
                commits: 0,
            });
            await state.finishSync(WORK_ID, { result: 'conflict', reason: 'conflict', commits: 3 });
            await state.finishSync(WORK_ID, { result: 'failed', reason: 'unauthorized' });
            await state.finishSync(WORK_ID, { result: 'paused', reason: 'upstream_archived' });
            expect(events('app.upstream.synced')).toHaveLength(1);
            expect((await stored()).lastSyncResult).toBe('paused');
        });

        it('counts consecutive rate-limited runs and resets on an ordinary one (FR-52)', async () => {
            await seedWork();
            await seedState(WORK_ID);
            const state = service();

            await state.finishSync(WORK_ID, {
                result: 'skipped',
                reason: 'skipped_rate_limited',
                rateLimited: true,
                rateLimitedUntil: new Date(Date.now() + 60_000),
            });
            await state.finishSync(WORK_ID, {
                result: 'skipped',
                reason: 'skipped_rate_limited',
                rateLimited: true,
            });
            expect((await stored()).consecutiveRateLimited).toBe(2);
            expect((await stored()).rateLimitedUntil).toBeInstanceOf(Date);

            await state.finishSync(WORK_ID, { result: 'up_to_date', reason: 'up_to_date' });
            expect((await stored()).consecutiveRateLimited).toBe(0);
        });

        it('takes the next slot from its caller and clears it when a run pauses (FR-32, FR-41)', async () => {
            await seedWork();
            await seedState(WORK_ID, { nextSyncAt: new Date(Date.now() + 1_000) });
            const state = service();
            const next = new Date(Date.now() + 86_400_000);

            await state.finishSync(WORK_ID, { result: 'up_to_date', nextSyncAt: next });
            expect((await stored()).nextSyncAt?.getTime()).toBe(next.getTime());

            await state.finishSync(WORK_ID, {
                result: 'paused',
                reason: 'upstream_archived',
                nextSyncAt: null,
            });
            expect((await stored()).nextSyncAt).toBeNull();
        });

        it('reports a missing row instead of inventing one', async () => {
            await expect(
                service().finishSync(MISSING_WORK_ID, { result: 'up_to_date' }),
            ).resolves.toEqual({
                found: false,
                emitted: false,
                duplicate: false,
                trackedBranchChanged: false,
            });
        });
    });

    // ── §6.5 — the conflict Task (ACC-02-11, R-21) ───────────────────────────

    describe('recordConflict', () => {
        const conflict = {
            pr: { number: 42, url: 'https://github.com/ever-works/cloc/pull/42' },
            fromSha: SHA_A,
            toSha: SHA_B,
            commits: 3,
        };

        const label = `${APP_UPSTREAM_CONFLICT_LABEL_PREFIX}${WORK_ID}`;

        it("takes the Task's Agent from APW-08's resolver, and never chooses one itself", async () => {
            await seedWork();
            await seedState();
            const resolver = {
                resolve: jest.fn().mockResolvedValue({ agentId: 'agent-7', source: 'pinned' }),
            };

            const result = await service({ resolver }).recordConflict(WORK_ID, conflict);

            expect(resolver.resolve).toHaveBeenCalledWith({ userId: OWNER, workId: WORK_ID });
            expect(result).toMatchObject({
                taskId: 'created-task-1',
                created: true,
                agentId: 'agent-7',
            });
            expect(doubles.tasks.create).toHaveBeenCalledWith(
                OWNER,
                expect.objectContaining({
                    labels: [label],
                    workId: WORK_ID,
                    agentId: 'agent-7',
                    createdByType: 'user',
                    createdById: OWNER,
                }),
                // AW-1: this pin used to expect two arguments, which encoded the defect —
                // the Task was filed with no ownership scope. It now carries the Work's
                // own (here an unscoped fixture Work, so both columns are null).
                { tenantId: null, organizationId: null },
            );
            expect(doubles.notifications.create).not.toHaveBeenCalled();
            expect(await stored()).toMatchObject({ conflictTaskId: 'created-task-1' });
            expect(events('app.upstream.conflict')).toHaveLength(1);
            expect(events('app.upstream.conflict')[0].details).toMatchObject({
                pullRequestNumber: 42,
                taskId: 'created-task-1',
                commits: 3,
            });
        });

        it('leaves the Task unassigned and notifies the owner exactly once when no Agent resolves', async () => {
            for (const resolver of [
                { resolve: jest.fn().mockResolvedValue(null) },
                { resolve: jest.fn().mockRejectedValue(new Error('resolver exploded')) },
                undefined,
            ]) {
                jest.clearAllMocks();
                await dataSource.getRepository(Task).clear();
                await dataSource.getRepository(WorkUpstreamState).clear();
                await dataSource.getRepository(Work).clear();
                await seedWork();
                await seedState();

                const result = await service({ resolver }).recordConflict(WORK_ID, conflict);

                expect(result.agentId).toBeNull();
                expect(doubles.tasks.create).toHaveBeenCalledWith(
                    OWNER,
                    expect.objectContaining({ agentId: null }),
                    // AW-1: the Work's ownership scope (was absent — the defect).
                    { tenantId: null, organizationId: null },
                );
                expect(doubles.notifications.create).toHaveBeenCalledTimes(1);
                expect(doubles.notifications.create).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: OWNER,
                        type: 'warning',
                        metadata: expect.objectContaining({ code: 'appRules.noAgentResolved' }),
                    }),
                );
            }
        });

        it('comments on the open labelled Task instead of duplicating it (ACC-02-11)', async () => {
            await seedWork();
            await seedState();
            const open = await seedTask({
                slug: 'conflict-1',
                labels: [label],
                status: TaskStatus.IN_REVIEW,
            });

            const result = await service().recordConflict(WORK_ID, conflict);

            expect(result).toMatchObject({ taskId: open.id, created: false, commented: true });
            expect(doubles.tasks.create).not.toHaveBeenCalled();
            expect(doubles.taskChat.post).toHaveBeenCalledTimes(1);

            const [authorId, posted] = doubles.taskChat.post.mock.calls[0];
            expect(authorId).toBe(OWNER);
            expect(posted).toMatchObject({
                taskId: open.id,
                authorType: 'user',
                authorId: OWNER,
            });
            // The exact §6.3 copy — and, asserted directly, no `@`: the chat service fans
            // out one agent run per `@<slug>` mention and this path must start none.
            expect(posted.body).toBe(
                `Upstream moved again: now ${SHA_B.slice(0, 7)} (3 commits since the last sync).`,
            );
            expect(posted.body).not.toContain('@');
            expect(doubles.notifications.create).not.toHaveBeenCalled();
            expect(await stored()).toMatchObject({ conflictTaskId: open.id });
            expect(events('app.upstream.conflict')).toHaveLength(1);
        });

        it('looks the Task up among exactly the five open statuses of plan §6.5', async () => {
            await seedWork();
            await seedState();
            await seedTask({ slug: 'conflict-2', labels: [label], status: TaskStatus.IN_REVIEW });
            const spy = jest.spyOn(taskRepository, 'findByUserIdFiltered');

            await service().recordConflict(WORK_ID, conflict);

            expect(spy).toHaveBeenCalledWith(
                OWNER,
                {
                    workId: WORK_ID,
                    label,
                    status: OPEN_STATUSES,
                },
                // AW-1: this pin used to expect an unscoped lookup (two arguments), which
                // encoded the defect. The lookup is now bounded by the Work's own scope.
                { tenantId: null, organizationId: null },
            );
            spy.mockRestore();
        });

        it('files a replacement Task when the labelled one is done or cancelled', async () => {
            for (const status of [TaskStatus.DONE, TaskStatus.CANCELLED]) {
                jest.clearAllMocks();
                await dataSource.getRepository(Task).clear();
                await dataSource.getRepository(WorkUpstreamState).clear();
                await dataSource.getRepository(Work).clear();
                await seedWork();
                await seedState();
                await seedTask({ slug: `closed-${status}`, labels: [label], status });

                const result = await service().recordConflict(WORK_ID, conflict);

                expect(doubles.taskChat.post).not.toHaveBeenCalled();
                expect(doubles.tasks.create).toHaveBeenCalledTimes(1);
                expect(result).toMatchObject({ created: true, commented: false });
            }
        });

        it('uses the paths the run computed, capped at fifty, and reads them back when absent', async () => {
            await seedWork();
            await seedState();

            const many = Array.from({ length: 60 }, (_value, index) => `src/file-${index}.ts`);
            const capped = await service().recordConflict(WORK_ID, { ...conflict, paths: many });
            expect(capped.paths).toHaveLength(50);
            expect(doubles.tasks.create.mock.calls[0][1].description).toContain('src/file-49.ts');
            expect(doubles.tasks.create.mock.calls[0][1].description).not.toContain(
                'src/file-50.ts',
            );

            jest.clearAllMocks();
            await dataSource.getRepository(Task).clear();
            const git = {
                getRepository: jest.fn(),
                getPullRequestFiles: jest
                    .fn()
                    .mockResolvedValue([{ filename: 'src/conflict.ts', status: 'modified' }]),
            };
            const read = await service({ git: git as never }).recordConflict(WORK_ID, conflict);

            expect(git.getPullRequestFiles).toHaveBeenCalledWith('ever-works', 'cloc', 42, {
                userId: OWNER,
                providerId: 'github',
                workId: WORK_ID,
            });
            expect(read.paths).toEqual(['src/conflict.ts']);
        });

        it('gives the Task the spec §6.3 title and the conflict description', async () => {
            await seedWork();
            await seedState();

            await service().recordConflict(WORK_ID, {
                ...conflict,
                paths: ['src/a.ts', 'src/b.ts'],
            });

            const input = doubles.tasks.create.mock.calls[0][1];
            expect(input.title).toBe('Resolve upstream sync conflicts in cloc');
            expect(input.description).toContain(
                `Upstream cloc-co/cloc moved from ${SHA_A.slice(0, 7)} to ${SHA_B.slice(0, 7)} (3 commits).`,
            );
            expect(input.description).toContain('https://github.com/ever-works/cloc/pull/42');
            expect(input.description).toContain('src/a.ts');
            expect(input.description).toContain(
                "Resolve the conflicts on ever-works/upstream-sync and push. Don't merge into main directly.",
            );
        });

        // ── AW-1: the conflict Task lives in the Work's own workspace ─────────
        //
        // The Task used to be filed with no ownership scope, so `TasksService.create`
        // stamped nothing and the row was written tenantId=null / organizationId=null
        // (the conflict runs from the worker, through the remote proxy, under an empty
        // request scope, so the stamping subscriber had nothing to fill in either). For
        // an App Work in an Organization that row is missing from the org board, from
        // the Work's Tasks list, and the Upstream card's "resolve conflict" link 404s.
        //
        // These cases write the Task the way the real `TasksService.create` does — the
        // stamp comes from its third argument and nowhere else (`ownershipStamp`) — and
        // then read it back through the REAL `TaskRepository` scope predicate the board
        // and the Task page use, so "visible in the org workspace" is asserted against
        // the production SQL rather than against an argument list.
        describe('ownership scope (AW-1)', () => {
            const ORG_SCOPE: OwnershipScope = { tenantId: TENANT_ID, organizationId: ORG_ID };
            const PERSONAL_SCOPE: OwnershipScope = { tenantId: TENANT_ID, organizationId: null };

            /** `TasksService.create`, reduced to the one behaviour under test: the stamp. */
            function persistingTasks(): { create: jest.Mock } {
                let next = 0;
                return {
                    create: jest
                        .fn()
                        .mockImplementation(
                            async (
                                userId: string,
                                input: Record<string, any>,
                                scope?: OwnershipScope,
                            ) => {
                                const repository = dataSource.getRepository(Task);
                                next += 1;
                                return repository.save(
                                    repository.create({
                                        userId,
                                        ...ownershipStamp(scope),
                                        slug: `T-${next}`,
                                        title: input.title,
                                        description: input.description ?? null,
                                        status: TaskStatus.BACKLOG,
                                        labels: input.labels ?? null,
                                        workId: input.workId ?? null,
                                        agentId: input.agentId ?? null,
                                        createdByType: input.createdByType,
                                        createdById: input.createdById,
                                    } as Partial<Task>),
                                );
                            },
                        ),
                };
            }

            /** The Work's Tasks as the board of one workspace lists them. */
            async function visibleIn(scope: OwnershipScope): Promise<string[]> {
                const { rows } = await taskRepository.findByUserIdFiltered(
                    OWNER,
                    { workId: WORK_ID },
                    scope,
                );
                return rows.map((row) => row.id);
            }

            it("files an org-scoped App Work's conflict Task in that Organization's workspace", async () => {
                await seedWork(WORK_ID, { tenantId: TENANT_ID, organizationId: ORG_ID });
                await seedState();
                const tasks = persistingTasks();

                const result = await service({ tasks }).recordConflict(WORK_ID, conflict);

                expect(result.created).toBe(true);
                expect(tasks.create).toHaveBeenCalledWith(
                    OWNER,
                    expect.objectContaining({ workId: WORK_ID, labels: [label] }),
                    ORG_SCOPE,
                );
                const row = await dataSource
                    .getRepository(Task)
                    .findOneByOrFail({ id: result.taskId as string });
                expect(row).toMatchObject({ tenantId: TENANT_ID, organizationId: ORG_ID });
                // Visible where the Work lives, and only there.
                expect(await visibleIn(ORG_SCOPE)).toEqual([result.taskId]);
                expect(await visibleIn(PERSONAL_SCOPE)).toEqual([]);
                expect(await stored()).toMatchObject({ conflictTaskId: result.taskId });
            });

            it("keeps a personal App Work's conflict Task personal", async () => {
                await seedWork(WORK_ID, { tenantId: TENANT_ID, organizationId: null });
                await seedState();
                const tasks = persistingTasks();

                const result = await service({ tasks }).recordConflict(WORK_ID, conflict);

                expect(tasks.create).toHaveBeenCalledWith(OWNER, expect.anything(), PERSONAL_SCOPE);
                const row = await dataSource
                    .getRepository(Task)
                    .findOneByOrFail({ id: result.taskId as string });
                expect(row).toMatchObject({ tenantId: TENANT_ID, organizationId: null });
                expect(await visibleIn(PERSONAL_SCOPE)).toEqual([result.taskId]);
                expect(await visibleIn(ORG_SCOPE)).toEqual([]);
            });

            it('comments a repeat conflict on the same org-scoped Task, through that scope', async () => {
                await seedWork(WORK_ID, { tenantId: TENANT_ID, organizationId: ORG_ID });
                await seedState();
                const tasks = persistingTasks();

                const first = await service({ tasks }).recordConflict(WORK_ID, conflict);
                const second = await service({ tasks }).recordConflict(WORK_ID, {
                    ...conflict,
                    commits: 4,
                });

                expect(tasks.create).toHaveBeenCalledTimes(1);
                expect(second).toMatchObject({
                    taskId: first.taskId,
                    created: false,
                    commented: true,
                });
                expect(doubles.taskChat.post).toHaveBeenCalledTimes(1);
                const [authorId, posted, lookups, scope] = doubles.taskChat.post.mock.calls[0];
                expect(authorId).toBe(OWNER);
                expect(posted).toMatchObject({ taskId: first.taskId });
                // No mention lookups: this path resolves no `@` and starts no run.
                expect(lookups).toEqual({});
                expect(scope).toEqual(ORG_SCOPE);
                expect(await visibleIn(ORG_SCOPE)).toEqual([first.taskId]);
            });

            it('does not comment on an open labelled Task that sits outside the Work scope', async () => {
                // The row the defect used to write: labelled, open, and stamped null/null
                // for an org-scoped Work — reachable from no workspace. Commenting on it
                // would keep the conflict invisible; a Task in the Work's scope is filed.
                await seedWork(WORK_ID, { tenantId: TENANT_ID, organizationId: ORG_ID });
                await seedState();
                const stray = await seedTask({
                    slug: 'unscoped-conflict',
                    labels: [label],
                    status: TaskStatus.BACKLOG,
                });
                const tasks = persistingTasks();

                const result = await service({ tasks }).recordConflict(WORK_ID, conflict);

                expect(doubles.taskChat.post).not.toHaveBeenCalled();
                expect(result).toMatchObject({ created: true, commented: false });
                expect(result.taskId).not.toBe(stray.id);
                expect(await visibleIn(ORG_SCOPE)).toEqual([result.taskId]);
            });

            it('tells the owner, and records the conflict in the Work scope', async () => {
                await seedWork(WORK_ID, { tenantId: TENANT_ID, organizationId: ORG_ID });
                await seedState();
                const tasks = persistingTasks();

                const result = await service({ tasks }).recordConflict(WORK_ID, conflict);

                // Notifications are per user, not per workspace (the notification list
                // carries no scope predicate), so the owner is the right and only
                // recipient; the Task link is the unprefixed route every Task
                // notification uses.
                expect(doubles.notifications.create).toHaveBeenCalledTimes(1);
                expect(doubles.notifications.create).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: OWNER,
                        actionUrl: `/tasks/${result.taskId}`,
                        metadata: expect.objectContaining({
                            workId: WORK_ID,
                            taskId: result.taskId,
                        }),
                    }),
                );
                // The Activity feed IS scope-filtered, so the event carries the Work's
                // scope explicitly rather than the (empty) scope of the worker's request.
                expect(events('app.upstream.conflict')).toHaveLength(1);
                expect(events('app.upstream.conflict')[0]).toMatchObject({
                    userId: OWNER,
                    workId: WORK_ID,
                    tenantId: TENANT_ID,
                    organizationId: ORG_ID,
                });
            });
        });
    });
});
