import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

import { ENTITIES } from '../../database/_entities-inventory';
import { NotificationRepository } from '../../database/repositories/notification.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { Notification } from '../../entities/notification.entity';
import { Work } from '../../entities/work.entity';
import { AppSpecAppliedEvent } from '../../events/app-spec-applied.event';
import { NotificationService } from '../../notifications/notification.service';
import { AppWorkIsolationService } from '../app-work-isolation.service';
import {
    APP_CHECKS_ADMISSION_ANCHOR,
    AppWorkSpecAppliedListener,
    appChecksAdmissionUrl,
} from '../app-spec-applied.listener';

/**
 * APW-08 T11 — the `app.spec.applied` listener that keeps an App Work's Task columns in step
 * with its App spec (plan §2.6).
 *
 * The Work rows and the notifications live in a REAL in-memory better-sqlite3 database, read and
 * written through the real `WorkRepository` (its ownership-scoped `updateAppWorkColumns`) and the
 * real `NotificationService` over the real `NotificationRepository` — so "writes nothing", "never
 * another kind" and "once per hash" are answered by rows, not by a double's bookkeeping. Only the
 * three branch sources (APW-03's spec read, its state row, and the git provider) are doubles.
 *
 * Covers: ACC-08-43 (unit half — the spec omits `source.branch`, the tracked branch then the
 * repository default answers, the column is never null), ACC-08-41 (a required check switches the
 * checks policy and the allowlist on, an owner's `'warn'` survives, no other kind is touched),
 * ACC-08-44 first half (one notification per hash, none on a no-op re-application), and a second
 * identical event writing nothing.
 */

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_OWNER = '00000000-0000-4000-8000-0000000000bb';
const COMMIT = 'c'.repeat(40);
const COMMIT_2 = 'd'.repeat(40);
const HASH = 'a'.repeat(64);
const HASH_2 = 'b'.repeat(64);

interface SpecFixture {
    status?: string;
    spec: Record<string, unknown> | null;
}

describe('APW-08 T11 — AppWorkSpecAppliedListener', () => {
    let dataSource: DataSource;
    let works: WorkRepository;
    let notificationRows: NotificationRepository;

    /** `getEffectiveSpec(workId, commitSha)` answers, keyed `workId@commit` (or `workId` for any commit). */
    let specReads: Map<string, SpecFixture>;
    let trackedBranches: Map<string, string>;
    let repositoryDefaults: Map<string, string | Error>;
    let specs: { getEffectiveSpec: jest.Mock };
    let specStates: { findByWorkId: jest.Mock };
    let git: { getRepository: jest.Mock };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // The owning User rows are not under test.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        works = new WorkRepository(dataSource.getRepository(Work));
        notificationRows = new NotificationRepository(dataSource.getRepository(Notification));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(Work).clear();
        await dataSource.getRepository(Notification).clear();
        specReads = new Map();
        trackedBranches = new Map();
        repositoryDefaults = new Map();
        specs = {
            getEffectiveSpec: jest.fn(async (workId: string, commitSha?: string) => {
                const fixture = specReads.get(`${workId}@${commitSha}`) ?? specReads.get(workId);
                if (!fixture) return null;
                return {
                    workId,
                    status: fixture.status ?? 'valid',
                    spec: fixture.spec,
                    specHash: HASH,
                    commitSha: commitSha ?? null,
                    issues: null,
                    errorCount: 0,
                    warningCount: 0,
                    source: 'read',
                    error: null,
                };
            }),
        };
        specStates = {
            findByWorkId: jest.fn(async (workId: string) =>
                trackedBranches.has(workId)
                    ? { workId, trackedBranch: trackedBranches.get(workId) }
                    : null,
            ),
        };
        git = {
            getRepository: jest.fn(async (owner: string, repo: string) => {
                const answer = repositoryDefaults.get(`${owner}/${repo}`);
                if (answer instanceof Error) throw answer;
                return answer
                    ? { defaultBranch: answer, cloneUrl: `https://github.com/${owner}/${repo}.git` }
                    : null;
            }),
        };
    });

    /** An App Work row whose Work Repository is `acme/shop` (the `website` role, APW-01's shape). */
    async function seedWork(over: Partial<Work> = {}): Promise<Work> {
        const rows = dataSource.getRepository(Work);
        return rows.save(
            rows.create({
                name: 'Shop',
                slug: `shop-${Math.random().toString(36).slice(2, 8)}`,
                description: 'An app',
                userId: OWNER,
                owner: 'acme',
                kind: 'app',
                gitProvider: 'github',
                sourceRepository: {
                    url: 'https://github.com/acme/shop',
                    owner: 'acme',
                    repo: 'shop',
                    type: 'app_fork',
                    importedAt: new Date('2026-10-01T00:00:00Z'),
                    relatedRepositories: { website: { owner: 'acme', repo: 'shop' } },
                } as unknown as Work['sourceRepository'],
                ...over,
            } as Partial<Work>),
        );
    }

    function stored(id: string): Promise<Work> {
        return dataSource.getRepository(Work).findOneOrFail({ where: { id } });
    }

    function event(
        over: Partial<ConstructorParameters<typeof AppSpecAppliedEvent>[0]> & { workId: string },
    ) {
        return new AppSpecAppliedEvent({
            commitSha: COMMIT,
            previousCommitSha: null,
            specHash: HASH,
            addedDependencies: [],
            changedEnvNames: [],
            changedBlocks: ['build'],
            ...over,
        });
    }

    function build(options: { notifications?: boolean } = {}) {
        const isolation = new AppWorkIsolationService(
            works,
            specs as never,
            specStates as never,
            git as never,
        );
        const notifications =
            options.notifications === false ? undefined : new NotificationService(notificationRows);
        const listener = new AppWorkSpecAppliedListener(
            works,
            isolation,
            notifications,
            options.notifications === false ? undefined : notificationRows,
        );
        return { listener, isolation, notifications };
    }

    // ── The source branch (APW08-G07, ACC-08-43 unit half) ──────────────

    describe('the source branch', () => {
        it("source branch `production` sets taskIsolationBaseBranch = 'production' — and isolation, and the Work Repository", async () => {
            const work = await seedWork();
            specReads.set(`${work.id}@${COMMIT}`, {
                spec: { kind: 'app', source: { relation: 'fork', branch: 'production' } },
            });

            const outcome = await build().listener.onSpecApplied(event({ workId: work.id }));

            expect(outcome).toMatchObject({
                reason: 'synced',
                branch: 'production',
                branchSource: 'spec',
            });
            const row = await stored(work.id);
            expect(row.taskIsolationBaseBranch).toBe('production');
            expect(row.taskIsolation).toBe('worktree');
            expect(row.taskIsolationTargetRepo).toBe('website');
            // The spec was read AT THE EVENT'S COMMIT, never at the head.
            expect(specs.getEffectiveSpec).toHaveBeenCalledWith(work.id, COMMIT);
            // A spec that names the branch needs no other source.
            expect(specStates.findByWorkId).not.toHaveBeenCalled();
            expect(git.getRepository).not.toHaveBeenCalled();
        });

        it('a spec that omits source.branch falls back to the tracked branch', async () => {
            const work = await seedWork();
            specReads.set(work.id, { spec: { kind: 'app', source: { relation: 'fork' } } });
            trackedBranches.set(work.id, 'release');

            const outcome = await build().listener.onSpecApplied(event({ workId: work.id }));

            expect(outcome).toMatchObject({ branch: 'release', branchSource: 'tracked' });
            expect((await stored(work.id)).taskIsolationBaseBranch).toBe('release');
            expect(git.getRepository).not.toHaveBeenCalled();
        });

        it('…and then to the Work Repository default — read on the `website` role, never `<slug>-data`', async () => {
            const work = await seedWork();
            specReads.set(work.id, { spec: { kind: 'app', source: { relation: 'fork' } } });
            repositoryDefaults.set('acme/shop', 'trunk');

            const outcome = await build().listener.onSpecApplied(event({ workId: work.id }));

            expect(outcome).toMatchObject({ branch: 'trunk', branchSource: 'repository' });
            expect((await stored(work.id)).taskIsolationBaseBranch).toBe('trunk');
            expect(git.getRepository).toHaveBeenCalledTimes(1);
            expect(git.getRepository).toHaveBeenCalledWith('acme', 'shop', {
                userId: OWNER,
                providerId: 'github',
                workId: work.id,
            });
            const [, repo] = git.getRepository.mock.calls[0];
            expect(repo).not.toMatch(/-data$/);
        });

        it('never leaves the column null while ANY source answers — whatever the spec read says', async () => {
            // An unusable spec (invalid) is not a source; the tracked branch answers.
            const invalid = await seedWork();
            specReads.set(invalid.id, {
                status: 'invalid',
                spec: { kind: 'app', source: { relation: 'fork', branch: 'from-an-invalid-spec' } },
            });
            trackedBranches.set(invalid.id, 'main');
            // No spec at all, no state row: the repository default answers.
            const bare = await seedWork();
            repositoryDefaults.set('acme/shop', 'main');

            const { listener } = build();
            await listener.onSpecApplied(event({ workId: invalid.id }));
            await listener.onSpecApplied(event({ workId: bare.id }));

            expect((await stored(invalid.id)).taskIsolationBaseBranch).toBe('main');
            expect((await stored(bare.id)).taskIsolationBaseBranch).toBe('main');
        });

        it('a tracked branch the column cannot hold is skipped for the next source, not written', async () => {
            const work = await seedWork();
            trackedBranches.set(work.id, 'x'.repeat(200));
            repositoryDefaults.set('acme/shop', 'main');

            await build().listener.onSpecApplied(event({ workId: work.id }));

            expect((await stored(work.id)).taskIsolationBaseBranch).toBe('main');
        });

        it('an unreadable repository leaves the base column as it is, and still switches isolation on', async () => {
            const work = await seedWork({ taskIsolationBaseBranch: null });
            repositoryDefaults.set('acme/shop', new Error('Bad credentials'));

            const outcome = await build().listener.onSpecApplied(event({ workId: work.id }));

            expect(outcome).toMatchObject({ branch: null, branchReason: 'repository_unreadable' });
            const row = await stored(work.id);
            expect(row.taskIsolationBaseBranch).toBeNull();
            expect(row.taskIsolation).toBe('worktree');
            expect(row.taskIsolationTargetRepo).toBe('website');
        });
    });

    // ── The checks switches (APW08-G02, ACC-08-41) ──────────────────────

    describe('the checks switches', () => {
        const withRequiredCheck = {
            kind: 'app',
            source: { relation: 'fork', branch: 'main' },
            checks: [{ name: 'Unit tests', command: 'pnpm test' }],
        };

        it("a required check sets checksPolicy = 'required' and the allowlist mode, in the same write", async () => {
            const work = await seedWork();
            specReads.set(work.id, { spec: withRequiredCheck });
            const update = jest.spyOn(works, 'updateAppWorkColumns');

            await build().listener.onSpecApplied(event({ workId: work.id }));

            const row = await stored(work.id);
            expect(row.checksPolicy).toBe('required');
            expect(row.repoDeclaredCommands).toEqual({ mode: 'allowlist', allow: [] });
            // ONE write carried every column (plan §2.6: "All six are written in one … update").
            expect(update).toHaveBeenCalledTimes(1);
            expect(Object.keys(update.mock.calls[0][2]).sort()).toEqual([
                'checksPolicy',
                'repoDeclaredCommands',
                'taskIsolation',
                'taskIsolationBaseBranch',
                'taskIsolationTargetRepo',
            ]);
            update.mockRestore();
        });

        it("an owner's own 'warn' survives a required check", async () => {
            const work = await seedWork({ checksPolicy: 'warn' });
            specReads.set(work.id, { spec: withRequiredCheck });

            await build().listener.onSpecApplied(event({ workId: work.id }));

            const row = await stored(work.id);
            expect(row.checksPolicy).toBe('warn');
            expect(row.repoDeclaredCommands).toEqual({ mode: 'allowlist', allow: [] });
        });

        it('a spec whose checks are all `required: false` leaves the policy alone', async () => {
            const work = await seedWork();
            specReads.set(work.id, {
                spec: {
                    ...withRequiredCheck,
                    checks: [{ name: 'Lint', command: 'pnpm lint', required: false }],
                },
            });

            await build().listener.onSpecApplied(event({ workId: work.id }));

            expect((await stored(work.id)).checksPolicy).toBe('off');
        });

        it('keeps an existing allow-list — even one stored under mode off — and never widens it', async () => {
            const work = await seedWork({
                repoDeclaredCommands: { mode: 'off', allow: ['pnpm  test', 'pnpm lint'] } as never,
            });
            specReads.set(work.id, { spec: withRequiredCheck });

            await build().listener.onSpecApplied(event({ workId: work.id }));

            expect((await stored(work.id)).repoDeclaredCommands).toEqual({
                mode: 'allowlist',
                allow: ['pnpm test', 'pnpm lint'],
            });
        });

        it('no other kind is touched — not read further, not written', async () => {
            const directory = await seedWork({ kind: 'directory' as Work['kind'] });
            specReads.set(directory.id, { spec: withRequiredCheck });
            const update = jest.spyOn(works, 'updateAppWorkColumns');

            const outcome = await build().listener.onSpecApplied(event({ workId: directory.id }));

            expect(outcome.reason).toBe('not_app');
            expect(update).not.toHaveBeenCalled();
            expect(specs.getEffectiveSpec).not.toHaveBeenCalled();
            const row = await stored(directory.id);
            expect(row.checksPolicy).toBe('off');
            expect(row.repoDeclaredCommands ?? null).toBeNull();
            expect(row.taskIsolation).toBe('off');
            expect(row.taskIsolationBaseBranch ?? null).toBeNull();
            expect(row.taskIsolationTargetRepo).toBe('work-output');
            update.mockRestore();
        });

        it("the write is ownership-scoped: kind = 'app' and the owner the listener read", async () => {
            const directory = await seedWork({ kind: 'directory' as Work['kind'] });
            const app = await seedWork();

            // Straight at the repository: a patch aimed at another kind, or at the right row
            // under the wrong owner, matches no row.
            await expect(
                works.updateAppWorkColumns(directory.id, OWNER, { taskIsolation: 'worktree' }),
            ).resolves.toBe(false);
            await expect(
                works.updateAppWorkColumns(app.id, OTHER_OWNER, { taskIsolation: 'worktree' }),
            ).resolves.toBe(false);
            expect((await stored(directory.id)).taskIsolation).toBe('off');
            expect((await stored(app.id)).taskIsolation).toBe('off');
            await expect(
                works.updateAppWorkColumns(app.id, OWNER, { taskIsolation: 'worktree' }),
            ).resolves.toBe(true);
        });
    });

    // ── Idempotent ──────────────────────────────────────────────────────

    it('a second identical event writes nothing', async () => {
        const work = await seedWork();
        specReads.set(work.id, {
            spec: {
                kind: 'app',
                source: { relation: 'fork', branch: 'production' },
                checks: [{ name: 'Unit tests', command: 'pnpm test' }],
            },
        });
        const { listener } = build();
        const first = await listener.onSpecApplied(
            event({ workId: work.id, changedBlocks: ['checks'] }),
        );
        expect(first.reason).toBe('synced');
        const after = await stored(work.id);

        const update = jest.spyOn(works, 'updateAppWorkColumns');
        const second = await listener.onSpecApplied(
            event({ workId: work.id, changedBlocks: ['checks'] }),
        );

        expect(second).toMatchObject({ reason: 'unchanged', written: [] });
        expect(update).not.toHaveBeenCalled();
        const again = await stored(work.id);
        expect(again.updatedAt).toEqual(after.updatedAt);
        expect(again).toMatchObject({
            taskIsolation: 'worktree',
            taskIsolationBaseBranch: 'production',
            taskIsolationTargetRepo: 'website',
            checksPolicy: 'required',
        });
        update.mockRestore();
    });

    // ── The owner is asked once (APW08-G19, ACC-08-44 first half) ───────

    describe('the checks-change notification', () => {
        const spec = {
            kind: 'app',
            source: { relation: 'fork', branch: 'main' },
            checks: [
                { name: 'Unit tests', command: 'pnpm test' },
                { name: 'Lint', command: 'pnpm lint', required: false },
            ],
        };

        async function noticesOf(userId: string): Promise<Notification[]> {
            return dataSource.getRepository(Notification).find({ where: { userId } });
        }

        it('fires ONCE for an application whose checks changed, linking to the App Checks admission card', async () => {
            const work = await seedWork();
            specReads.set(work.id, { spec });

            const outcome = await build().listener.onSpecApplied(
                event({ workId: work.id, changedBlocks: ['checks', 'source'] }),
            );

            expect(outcome).toMatchObject({ notified: true, notifyReason: 'notified' });
            const notices = await noticesOf(OWNER);
            expect(notices).toHaveLength(1);
            expect(notices[0]).toMatchObject({
                userId: OWNER,
                category: 'task',
                actionUrl: `/works/${work.id}/settings#${APP_CHECKS_ADMISSION_ANCHOR}`,
                actionLabel: 'Review checks',
            });
            expect(notices[0].actionUrl).toBe(appChecksAdmissionUrl(work.id));
            expect(notices[0].message).toContain('Unit tests, Lint');
            expect(notices[0].metadata).toMatchObject({
                code: 'appRules.reviewChecks',
                workId: work.id,
                specHash: HASH,
                checkCount: 2,
            });
        });

        it('a no-op re-application (the same spec hash at the same commit) notifies nobody — dismissed or not', async () => {
            const work = await seedWork();
            specReads.set(work.id, { spec });
            const { listener, notifications } = build();
            const create = jest.spyOn(notifications!, 'create');
            const applied = event({ workId: work.id, changedBlocks: ['checks'] });

            await listener.onSpecApplied(applied);
            // The owner dismisses it — `create` alone would re-arm the key.
            const [notice] = await noticesOf(OWNER);
            await dataSource.getRepository(Notification).update(notice.id, { isDismissed: true });
            const again = await listener.onSpecApplied(applied);

            expect(again).toMatchObject({ notified: false, notifyReason: 'already_notified' });
            expect(create).toHaveBeenCalledTimes(1);
            expect(await noticesOf(OWNER)).toHaveLength(1);
        });

        it('a re-application whose checks did NOT change notifies nobody', async () => {
            const work = await seedWork();
            specReads.set(work.id, { spec });
            const { listener } = build();

            const outcome = await listener.onSpecApplied(
                event({
                    workId: work.id,
                    specHash: HASH_2,
                    commitSha: COMMIT_2,
                    changedBlocks: ['build', 'env'],
                }),
            );

            expect(outcome).toMatchObject({ notified: false, notifyReason: 'checks_unchanged' });
            expect(await noticesOf(OWNER)).toHaveLength(0);
        });

        it('one notification per hash: a new hash with changed checks asks again', async () => {
            const work = await seedWork();
            specReads.set(work.id, { spec });
            const { listener } = build();

            await listener.onSpecApplied(event({ workId: work.id, changedBlocks: ['checks'] }));
            await listener.onSpecApplied(
                event({
                    workId: work.id,
                    specHash: HASH_2,
                    commitSha: COMMIT_2,
                    changedBlocks: ['checks'],
                }),
            );
            // …and the second hash, re-delivered, is still one.
            await listener.onSpecApplied(
                event({
                    workId: work.id,
                    specHash: HASH_2,
                    commitSha: COMMIT_2,
                    changedBlocks: ['checks'],
                }),
            );

            expect(await noticesOf(OWNER)).toHaveLength(2);
        });

        it('a checks list that went empty, or a spec that could not be read, asks nothing', async () => {
            const emptied = await seedWork();
            specReads.set(emptied.id, { spec: { ...spec, checks: [] } });
            const unreadable = await seedWork();
            specReads.set(unreadable.id, { status: 'unreadable', spec: null });
            trackedBranches.set(unreadable.id, 'main');
            const { listener } = build();

            const a = await listener.onSpecApplied(
                event({ workId: emptied.id, changedBlocks: ['checks'] }),
            );
            const b = await listener.onSpecApplied(
                event({ workId: unreadable.id, changedBlocks: ['checks'] }),
            );

            expect(a.notifyReason).toBe('no_checks');
            expect(b.notifyReason).toBe('spec_unreadable');
            expect(await noticesOf(OWNER)).toHaveLength(0);
        });

        it('another kind is never notified', async () => {
            const directory = await seedWork({ kind: 'directory' as Work['kind'] });
            specReads.set(directory.id, { spec });

            await build().listener.onSpecApplied(
                event({ workId: directory.id, changedBlocks: ['checks'] }),
            );

            expect(await noticesOf(OWNER)).toHaveLength(0);
        });

        it('without a notification store the columns are still written', async () => {
            const work = await seedWork();
            specReads.set(work.id, { spec });

            const outcome = await build({ notifications: false }).listener.onSpecApplied(
                event({ workId: work.id, changedBlocks: ['checks'] }),
            );

            expect(outcome).toMatchObject({
                reason: 'synced',
                notified: false,
                notifyReason: 'unbound',
            });
        });
    });

    // ── Never throws into the event fan-out ─────────────────────────────

    it('a failed read is reported, never thrown', async () => {
        const broken = {
            findById: jest.fn().mockRejectedValue(new Error('database is gone')),
        } as unknown as WorkRepository;
        const listener = new AppWorkSpecAppliedListener(
            broken,
            new AppWorkIsolationService(broken),
        );

        await expect(listener.onSpecApplied(event({ workId: 'w-1' }))).resolves.toMatchObject({
            reason: 'failed',
        });
    });

    it('an invalid payload, an unknown Work and an unbound resolver each name themselves', async () => {
        const { listener } = build();
        await expect(
            listener.onSpecApplied(
                new AppSpecAppliedEvent({ workId: '', commitSha: COMMIT } as never),
            ),
        ).resolves.toMatchObject({ reason: 'invalid_payload' });
        await expect(
            listener.onSpecApplied(event({ workId: '00000000-0000-4000-8000-00000000ffff' })),
        ).resolves.toMatchObject({ reason: 'no_work' });
        await expect(
            new AppWorkSpecAppliedListener(works).onSpecApplied(event({ workId: 'w-1' })),
        ).resolves.toMatchObject({ reason: 'unbound' });
    });

    it('listens on the canonical `app.spec.applied` wire name, asynchronously', () => {
        const source = readFileSync(join(__dirname, '..', 'app-spec-applied.listener.ts'), 'utf8');
        expect(source).toContain('@OnEvent(AppSpecAppliedEvent.EVENT_NAME, { async: true })');
        expect(AppSpecAppliedEvent.EVENT_NAME).toBe('app.spec.applied');
    });
});
