import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

import { ENTITIES } from '../../database/_entities-inventory';
import { WorkRepository } from '../../database/repositories/work.repository';
import { Work } from '../../entities/work.entity';
import { AppSpecAppliedEvent } from '../../events/app-spec-applied.event';
import { AppWorkSpecAppliedListener } from '../app-spec-applied.listener';
import { AppWorkIsolationService } from '../app-work-isolation.service';
import {
    APP_WORK_ISOLATION_BACKFILL_PAGE,
    AppWorkIsolationBackfillRunner,
    type AppWorkIsolationBackfillSummary,
} from '../app-work-isolation-backfill.runner';

/**
 * APW-08 T50 — the one-off backfill of App Work isolation columns (APW08-G07, ACC-08-43).
 *
 * The Works live in a REAL in-memory better-sqlite3 table, walked by the real
 * `WorkRepository.findAppWorkIdsWithoutIsolationBase` page query and written by its real
 * ownership-scoped `updateAppWorkColumns` — so "a non-`app` Work is never visited" and "a second
 * run writes nothing" are answered by the query and the rows. The three branch sources (APW-03's
 * spec read and state row, and the git provider) are doubles, shared with T11's listener so the
 * two can be compared on the same fixtures.
 */

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const COMMIT = 'c'.repeat(40);

describe('APW-08 T50 — AppWorkIsolationBackfillRunner', () => {
    let dataSource: DataSource;
    let works: WorkRepository;

    let specBranches: Map<string, string>;
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
        await dataSource.query('PRAGMA foreign_keys = OFF');
        works = new WorkRepository(dataSource.getRepository(Work));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(Work).clear();
        specBranches = new Map();
        trackedBranches = new Map();
        repositoryDefaults = new Map();
        specs = {
            getEffectiveSpec: jest.fn(async (workId: string) => ({
                workId,
                status: 'valid',
                spec: {
                    kind: 'app',
                    source: {
                        relation: 'fork',
                        ...(specBranches.has(workId) ? { branch: specBranches.get(workId) } : {}),
                    },
                },
                specHash: 'a'.repeat(64),
                commitSha: COMMIT,
                issues: null,
                errorCount: 0,
                warningCount: 0,
                source: 'stored',
                error: null,
            })),
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
                return answer ? { defaultBranch: answer } : null;
            }),
        };
    });

    let seq = 0;
    /** A Work row; App Works get a Work Repository `acme/<repo>` on the `website` role. */
    async function seedWork(over: Partial<Work> & { repo?: string } = {}): Promise<Work> {
        const { repo = `app-${seq}`, ...rest } = over;
        seq += 1;
        const rows = dataSource.getRepository(Work);
        return rows.save(
            rows.create({
                name: `Work ${seq}`,
                slug: `work-${seq}`,
                description: 'A Work',
                userId: OWNER,
                owner: 'acme',
                kind: 'app',
                gitProvider: 'github',
                sourceRepository: {
                    url: `https://github.com/acme/${repo}`,
                    owner: 'acme',
                    repo,
                    type: 'app_fork',
                    importedAt: new Date('2026-10-01T00:00:00Z'),
                    relatedRepositories: { website: { owner: 'acme', repo } },
                } as unknown as Work['sourceRepository'],
                ...rest,
            } as Partial<Work>),
        );
    }

    function stored(id: string): Promise<Work> {
        return dataSource.getRepository(Work).findOneOrFail({ where: { id } });
    }

    function isolation(): AppWorkIsolationService {
        return new AppWorkIsolationService(
            works,
            specs as never,
            specStates as never,
            git as never,
        );
    }

    function runner(shared: AppWorkIsolationService = isolation()): AppWorkIsolationBackfillRunner {
        return new AppWorkIsolationBackfillRunner(works, shared);
    }

    /** Every page, the way the Trigger task walks them. */
    async function runAll(
        subject: AppWorkIsolationBackfillRunner,
        options: { limit?: number; dryRun?: boolean } = {},
    ): Promise<AppWorkIsolationBackfillSummary[]> {
        const pages: AppWorkIsolationBackfillSummary[] = [];
        let afterId: string | null = null;
        for (let i = 0; i < 50; i += 1) {
            const page = await subject.run({ ...options, afterId });
            pages.push(page);
            if (page.done) break;
            afterId = page.nextAfterId;
        }
        return pages;
    }

    function total(
        pages: AppWorkIsolationBackfillSummary[],
        key: 'scanned' | 'updated' | 'skipped' | 'unresolved' | 'failed',
    ) {
        return pages.reduce((sum, page) => sum + page[key], 0);
    }

    it('fills a null column from each of the three sources, in order', async () => {
        const fromSpec = await seedWork({ repo: 'one' });
        specBranches.set(fromSpec.id, 'production');
        trackedBranches.set(fromSpec.id, 'not-this-one');
        const fromTracked = await seedWork({ repo: 'two' });
        trackedBranches.set(fromTracked.id, 'release');
        repositoryDefaults.set('acme/two', 'not-this-one');
        const fromRepository = await seedWork({ repo: 'three' });
        repositoryDefaults.set('acme/three', 'trunk');

        const [page] = await runAll(runner());

        expect(page).toMatchObject({
            scanned: 3,
            updated: 3,
            unresolved: 0,
            failed: 0,
            bySource: { spec: 1, tracked: 1, repository: 1 },
            done: true,
        });
        for (const [work, branch] of [
            [fromSpec, 'production'],
            [fromTracked, 'release'],
            [fromRepository, 'trunk'],
        ] as const) {
            expect(await stored(work.id)).toMatchObject({
                taskIsolation: 'worktree',
                taskIsolationBaseBranch: branch,
                taskIsolationTargetRepo: 'website',
            });
        }
        // Step 3 read the Work Repository (the `website` role), never `<slug>-data`.
        expect(git.getRepository).toHaveBeenCalledTimes(1);
        expect(git.getRepository).toHaveBeenCalledWith('acme', 'three', {
            userId: OWNER,
            providerId: 'github',
            workId: fromRepository.id,
        });
    });

    it('writes ONLY the three isolation columns, through the ownership-scoped update', async () => {
        const work = await seedWork({ checksPolicy: 'off' });
        repositoryDefaults.set(`acme/app-${seq - 1}`, 'main');
        const update = jest.spyOn(works, 'updateAppWorkColumns');

        await runAll(runner());

        expect(update).toHaveBeenCalledTimes(1);
        const [id, userId, patch] = update.mock.calls[0];
        expect(id).toBe(work.id);
        expect(userId).toBe(OWNER);
        expect(Object.keys(patch).sort()).toEqual([
            'taskIsolation',
            'taskIsolationBaseBranch',
            'taskIsolationTargetRepo',
        ]);
        const row = await stored(work.id);
        expect(row.checksPolicy).toBe('off');
        expect(row.repoDeclaredCommands ?? null).toBeNull();
        update.mockRestore();
    });

    it('leaves a Work that already carries a base branch untouched — it is never even visited', async () => {
        const work = await seedWork({ taskIsolationBaseBranch: 'develop', taskIsolation: 'off' });
        specBranches.set(work.id, 'production');

        const [page] = await runAll(runner());

        expect(page).toMatchObject({ scanned: 0, updated: 0, done: true });
        expect(specs.getEffectiveSpec).not.toHaveBeenCalled();
        expect(await stored(work.id)).toMatchObject({
            taskIsolationBaseBranch: 'develop',
            taskIsolation: 'off',
            taskIsolationTargetRepo: 'work-output',
        });
    });

    it('a second run writes nothing', async () => {
        const a = await seedWork({ repo: 'a' });
        specBranches.set(a.id, 'production');
        const b = await seedWork({ repo: 'b' });
        repositoryDefaults.set('acme/b', 'main');
        const first = await runAll(runner());
        expect(total(first, 'updated')).toBe(2);
        const before = [await stored(a.id), await stored(b.id)];

        const update = jest.spyOn(works, 'updateAppWorkColumns');
        specs.getEffectiveSpec.mockClear();
        git.getRepository.mockClear();
        const second = await runAll(runner());

        expect(total(second, 'scanned')).toBe(0);
        expect(total(second, 'updated')).toBe(0);
        expect(update).not.toHaveBeenCalled();
        expect(specs.getEffectiveSpec).not.toHaveBeenCalled();
        expect(git.getRepository).not.toHaveBeenCalled();
        expect([await stored(a.id), await stored(b.id)]).toEqual(before);
        update.mockRestore();
    });

    it('never visits a non-`app` Work, whatever its columns say', async () => {
        const directory = await seedWork({ kind: 'directory' as Work['kind'], repo: 'dir' });
        const project = await seedWork({ kind: 'project' as Work['kind'], repo: 'proj' });
        const findById = jest.spyOn(works, 'findById');

        const [page] = await runAll(runner());

        expect(page.scanned).toBe(0);
        expect(findById).not.toHaveBeenCalled();
        expect(specs.getEffectiveSpec).not.toHaveBeenCalled();
        for (const work of [directory, project]) {
            expect(await stored(work.id)).toMatchObject({
                taskIsolation: 'off',
                taskIsolationTargetRepo: 'work-output',
            });
            expect((await stored(work.id)).taskIsolationBaseBranch ?? null).toBeNull();
        }
        findById.mockRestore();
    });

    it('counts a Work whose repository is unreadable and leaves it alone, without failing the run', async () => {
        const unreadable = await seedWork({ repo: 'gone' });
        repositoryDefaults.set('acme/gone', new Error('Not Found'));
        const fine = await seedWork({ repo: 'fine' });
        repositoryDefaults.set('acme/fine', 'main');

        const [page] = await runAll(runner());

        expect(page).toMatchObject({ scanned: 2, updated: 1, unresolved: 1, failed: 0 });
        expect(page.unresolvedWorkIds).toEqual([unreadable.id]);
        const row = await stored(unreadable.id);
        expect(row.taskIsolationBaseBranch ?? null).toBeNull();
        // Left ALONE: not half-written either.
        expect(row.taskIsolation).toBe('off');
        expect(row.taskIsolationTargetRepo).toBe('work-output');
        expect((await stored(fine.id)).taskIsolationBaseBranch).toBe('main');
    });

    it('counts a Work whose read throws, and moves on', async () => {
        const broken = await seedWork({ repo: 'broken' });
        const fine = await seedWork({ repo: 'ok' });
        repositoryDefaults.set('acme/ok', 'main');
        const realFindById = works.findById.bind(works);
        const findById = jest.spyOn(works, 'findById').mockImplementation(async (id: string) => {
            if (id === broken.id) throw new Error('row is corrupt');
            return realFindById(id);
        });

        const [page] = await runAll(runner());

        expect(page).toMatchObject({ scanned: 2, updated: 1, failed: 1 });
        expect(page.failedWorkIds).toEqual([broken.id]);
        expect((await stored(fine.id)).taskIsolationBaseBranch).toBe('main');
        findById.mockRestore();
    });

    it('walks every page with a keyset cursor, and a dry run writes nothing', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
            const work = await seedWork({ repo: `paged-${i}` });
            repositoryDefaults.set(`acme/paged-${i}`, 'main');
            ids.push(work.id);
        }

        const dry = await runAll(runner(), { limit: 2, dryRun: true });
        expect(dry.map((page) => page.scanned)).toEqual([2, 2, 1]);
        expect(total(dry, 'updated')).toBe(5);
        expect(dry.every((page) => page.dryRun)).toBe(true);
        for (const id of ids) {
            expect((await stored(id)).taskIsolationBaseBranch ?? null).toBeNull();
        }

        const real = await runAll(runner(), { limit: 2 });
        expect(total(real, 'updated')).toBe(5);
        for (const id of ids) {
            expect((await stored(id)).taskIsolationBaseBranch).toBe('main');
        }
    });

    it('clamps the page size to 1..100, defaulting to 25', async () => {
        const page = jest.spyOn(works, 'findAppWorkIdsWithoutIsolationBase');
        const subject = runner();
        await subject.run({});
        await subject.run({ limit: 0 });
        await subject.run({ limit: 1000 });
        expect(page.mock.calls.map(([limit]) => limit)).toEqual([
            APP_WORK_ISOLATION_BACKFILL_PAGE,
            APP_WORK_ISOLATION_BACKFILL_PAGE,
            100,
        ]);
        page.mockRestore();
    });

    // ── The same resolver as T11's listener ─────────────────────────────

    describe('resolves the branch with the SAME resolver as the listener', () => {
        it('both the listener and the runner go through AppWorkIsolationService.resolveSourceBranch', async () => {
            const forRunner = await seedWork({ repo: 'r' });
            trackedBranches.set(forRunner.id, 'release');
            const forListener = await seedWork({ repo: 'l', taskIsolationBaseBranch: null });
            trackedBranches.set(forListener.id, 'release');
            const shared = isolation();
            const resolve = jest.spyOn(shared, 'resolveSourceBranch');

            // The listener first (so its Work is no longer a backfill candidate)…
            await new AppWorkSpecAppliedListener(works, shared).onSpecApplied(
                new AppSpecAppliedEvent({
                    workId: forListener.id,
                    commitSha: COMMIT,
                    previousCommitSha: null,
                    specHash: 'a'.repeat(64),
                    addedDependencies: [],
                    changedEnvNames: [],
                    changedBlocks: ['build'],
                }),
            );
            // …then the runner.
            await runAll(runner(shared));

            expect(resolve.mock.calls.map(([work]) => work.id).sort()).toEqual(
                [forListener.id, forRunner.id].sort(),
            );
            resolve.mockRestore();
        });

        it.each([
            ['the spec', { spec: 'production' }, 'production'],
            ['the tracked branch', { tracked: 'release' }, 'release'],
            ['the repository default', { repository: 'trunk' }, 'trunk'],
        ])(
            'answers what the listener writes when the branch comes from %s',
            async (_, sources, branch) => {
                const viaListener = await seedWork({ repo: 'via-listener' });
                const viaRunner = await seedWork({ repo: 'via-runner' });
                for (const work of [viaListener, viaRunner]) {
                    if ('spec' in sources) specBranches.set(work.id, sources.spec as string);
                    if ('tracked' in sources)
                        trackedBranches.set(work.id, sources.tracked as string);
                }
                if ('repository' in sources) {
                    repositoryDefaults.set('acme/via-listener', sources.repository as string);
                    repositoryDefaults.set('acme/via-runner', sources.repository as string);
                }
                const shared = isolation();

                await new AppWorkSpecAppliedListener(works, shared).onSpecApplied(
                    new AppSpecAppliedEvent({
                        workId: viaListener.id,
                        commitSha: COMMIT,
                        previousCommitSha: null,
                        specHash: 'a'.repeat(64),
                        addedDependencies: [],
                        changedEnvNames: [],
                        changedBlocks: ['build'],
                    }),
                );
                await runAll(runner(shared));

                const [listenerRow, runnerRow] = [
                    await stored(viaListener.id),
                    await stored(viaRunner.id),
                ];
                expect(runnerRow.taskIsolationBaseBranch).toBe(branch);
                expect(runnerRow.taskIsolationBaseBranch).toBe(listenerRow.taskIsolationBaseBranch);
                expect(runnerRow.taskIsolation).toBe(listenerRow.taskIsolation);
                expect(runnerRow.taskIsolationTargetRepo).toBe(listenerRow.taskIsolationTargetRepo);
            },
        );

        it('owns no copy of the resolution: the runner reads no branch source itself', () => {
            const source = readFileSync(
                join(__dirname, '..', 'app-work-isolation-backfill.runner.ts'),
                'utf8',
            )
                // Comments describe the order; only code may not perform it.
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/.*$/gm, '');
            for (const forbidden of [
                'getEffectiveSpec',
                'findByWorkId',
                'trackedBranch',
                'getRepository',
                'defaultBranch',
                'source?.branch',
                'updateAppWorkColumns',
            ]) {
                expect({ forbidden, found: source.includes(forbidden) }).toEqual({
                    forbidden,
                    found: false,
                });
            }
            expect(source).toContain('this.isolation.resolveSourceBranch(work)');
            expect(source).toContain('this.isolation.apply(work, patch)');
        });
    });
});
