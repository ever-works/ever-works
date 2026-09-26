import { DataSource } from 'typeorm';
import type { EntityManager, Repository } from 'typeorm';
import type { User } from '../../../entities/user.entity';
import { Work } from '../../../entities/work.entity';
import { WorkUpstreamState } from '../../../entities/work-upstream-state.entity';
import { ENTITIES } from '../../_entities-inventory';
import { WorkRepository } from '../work.repository';
import { WorkUpstreamStateRepository } from '../work-upstream-state.repository';

/**
 * APW-01 — the two new Work lookups the create path calls, the transaction
 * seam it calls them through, and the manager-aware writes that let a Work and
 * its `work_upstream_states` row commit together.
 *
 * Spec FR-08/FR-55; plan §3.1 (`plan.md:234`, `plan.md:240`) and §7
 * (`plan.md:892-930`).
 *
 * Each lookup is proved twice, on purpose:
 *
 *   - **executed** against a real in-memory better-sqlite3 database, exactly as
 *     `work-app-spec-state.repository.spec.ts` covers the sibling
 *     `findAppWorksByDataRepoFullName`. `sourceRepository` is a `simple-json`
 *     column, so the role comparison is the half a mocked builder cannot check:
 *     the SQL narrows the candidates and the code decides the match.
 *   - **shaped** through a mocked query builder, so a predicate that is emitted
 *     but wrong — or silently dropped — fails even when the fixture rows happen
 *     to agree.
 *
 * The transaction tests are split the same way: the delegation to
 * `EntityManager.transaction` is pinned on a fake, and the commit/rollback
 * behaviour is proved against the real database, because only the real driver
 * can show a row that is really gone after a throw.
 *
 * Every uuid below is obviously synthetic; no host or address appears.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const WORK_C = '33333333-3333-4333-8333-333333333333';
const WORK_D = '44444444-4444-4444-8444-444444444444';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A fixed import stamp, so a seeded row is byte-identical across runs. */
const STAMP = '2026-03-01T00:00:00.000Z';

describe('WorkRepository — APW-01 app lookups and the transaction seam', () => {
    let dataSource: DataSource;
    let works: WorkRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // Neither an owning `users` row nor the `work_upstream_states` FK is
        // what is under test: the columns are what the lookups read.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        works = new WorkRepository(dataSource.getRepository(Work));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(WorkUpstreamState).clear();
        await dataSource.query('DELETE FROM "works"');
    });

    /** `<owner>/<repo>` → the role object the `simple-json` column stores. */
    const role = (fullName: string) => {
        const [owner, repo] = fullName.split('/');
        return { owner, repo };
    };

    interface SeedOptions {
        userId?: string;
        kind?: string;
        /** The indexed `works.owner` column — the code repository's owner. */
        owner?: string | null;
        /** Omitted from the JSON entirely when `undefined`; passed through as-is otherwise. */
        website?: { owner: string; repo: string } | null;
        data?: { owner: string; repo: string } | null;
        /** Replaces the whole `sourceRepository` value (the malformed-row cases). */
        sourceRepository?: unknown;
    }

    /** Insert a Work with the columns the two lookups read. */
    async function seed(id: string, options: SeedOptions = {}): Promise<string> {
        const relatedRepositories: Record<string, unknown> = {};
        if (options.website) {
            relatedRepositories.website = options.website;
        }
        if (options.data) {
            relatedRepositories.data = options.data;
        }

        const rows = dataSource.getRepository(Work);
        const saved = await rows.save(
            rows.create({
                id,
                name: `Work ${id.slice(0, 4)}`,
                slug: `work-${id.slice(0, 4)}`,
                description: '',
                userId: options.userId ?? USER_A,
                kind: (options.kind ?? 'app') as Work['kind'],
                owner: options.owner === undefined ? 'member' : options.owner,
                sourceRepository:
                    options.sourceRepository === undefined
                        ? {
                              url: 'https://github.com/member/my-app',
                              owner: 'member',
                              repo: 'my-app',
                              type: 'app_fork',
                              importedAt: new Date(STAMP),
                              relatedRepositories,
                          }
                        : options.sourceRepository,
            } as Partial<Work>),
        );
        return saved.id;
    }

    describe('findAppWorksByDataRepository (executed)', () => {
        it('finds an App Work by its Work Repository (the `website` role), case-insensitively', async () => {
            await seed(WORK_A, { owner: 'Member', website: role('Member/My-App') });

            const found = await works.findAppWorksByDataRepository(USER_A, 'member', 'my-app');

            expect(found.map((work) => work.id)).toEqual([WORK_A]);
            // The comparison is case-insensitive on the caller's side too.
            expect(
                (await works.findAppWorksByDataRepository(USER_A, 'MEMBER', 'MY-APP')).map(
                    (work) => work.id,
                ),
            ).toEqual([WORK_A]);
        });

        it('returns every own App Work on that repository, not just the first', async () => {
            await seed(WORK_A, { website: role('member/my-app') });
            await seed(WORK_B, { website: role('member/my-app') });
            await seed(WORK_C, { website: role('member/other-app') });

            const found = await works.findAppWorksByDataRepository(USER_A, 'member', 'my-app');

            expect(found.map((work) => work.id).sort()).toEqual([WORK_A, WORK_B]);
        });

        it('ignores a `repo` Work wrapping the same repository — only `kind = app` is an App Work', async () => {
            await seed(WORK_A, { kind: 'repo', owner: 'member', data: role('member/my-app') });
            await seed(WORK_B, { kind: 'repo', owner: 'member', website: role('member/my-app') });

            expect(await works.findAppWorksByDataRepository(USER_A, 'member', 'my-app')).toEqual(
                [],
            );
        });

        it('ignores a row of any other kind that happens to carry the role', async () => {
            await seed(WORK_A, { kind: 'default', website: role('member/my-app') });
            await seed(WORK_B, { kind: 'website', website: role('member/my-app') });

            expect(await works.findAppWorksByDataRepository(USER_A, 'member', 'my-app')).toEqual(
                [],
            );
        });

        it('never matches a row whose `website` owner or repo is missing or blank', async () => {
            // No role at all — the shape an App Work has before APW-01 records one.
            await seed(WORK_A, { owner: 'member' });
            // A blank coordinate, a role with no coordinates, and no
            // `sourceRepository` whatsoever.
            await seed(WORK_B, { owner: 'member', website: { owner: '', repo: 'my-app' } });
            await seed(WORK_C, { owner: 'member', website: { owner: 'member', repo: '' } });
            await seed(WORK_D, { owner: 'member', website: { owner: '', repo: '' } });

            expect(await works.findAppWorksByDataRepository(USER_A, 'member', 'my-app')).toEqual(
                [],
            );
        });

        it('never matches the `data` role — an App Work’s code is the Work Repository', async () => {
            // plan.md:240 — the app-code fork is recorded under `website`,
            // never `data`; `data` role is the Work's data.
            await seed(WORK_A, {
                owner: 'member',
                data: role('member/my-app'),
                website: role('member/other-app'),
            });

            expect(await works.findAppWorksByDataRepository(USER_A, 'member', 'my-app')).toEqual(
                [],
            );
            expect(
                (await works.findAppWorksByDataRepository(USER_A, 'member', 'other-app')).map(
                    (work) => work.id,
                ),
            ).toEqual([WORK_A]);
        });

        it("does not match another account's App Work on the same repository", async () => {
            await seed(WORK_A, { userId: USER_A, website: role('member/my-app') });
            await seed(WORK_B, { userId: USER_B, website: role('member/my-app') });

            expect(
                (await works.findAppWorksByDataRepository(USER_A, 'member', 'my-app')).map(
                    (work) => work.id,
                ),
            ).toEqual([WORK_A]);
        });

        it('returns the hydrated Work rows, not a projection', async () => {
            await seed(WORK_A, { website: role('member/my-app') });

            const [found] = await works.findAppWorksByDataRepository(USER_A, 'member', 'my-app');

            expect(found.slug).toBe('work-1111');
            expect(found.kind).toBe('app');
            expect(found.sourceRepository?.relatedRepositories?.website).toEqual(
                role('member/my-app'),
            );
        });

        it('answers [] for a blank owner or repo', async () => {
            await seed(WORK_A, { website: role('member/my-app') });

            expect(await works.findAppWorksByDataRepository(USER_A, '', 'my-app')).toEqual([]);
            expect(await works.findAppWorksByDataRepository(USER_A, 'member', '')).toEqual([]);
        });
    });

    describe('findWorksUsingRepository (executed)', () => {
        it('names the role that matched: `data` for a `repo` Work, `website` for an App Work', async () => {
            await seed(WORK_A, { kind: 'repo', owner: 'Member', data: role('Member/My-Repo') });
            await seed(WORK_B, { kind: 'app', owner: 'Member', website: role('Member/My-Repo') });

            const found = await works.findWorksUsingRepository('member', 'my-repo');

            expect(found).toHaveLength(2);
            const byKind = new Map(found.map((row) => [row.kind, row]));
            expect(byKind.get('repo')).toEqual({
                id: WORK_A,
                userId: USER_A,
                kind: 'repo',
                relation: 'data',
            });
            expect(byKind.get('app')).toEqual({
                id: WORK_B,
                userId: USER_A,
                kind: 'app',
                relation: 'website',
            });
        });

        it('matches case-insensitively on both coordinates', async () => {
            await seed(WORK_A, { kind: 'repo', owner: 'MeMbEr', data: role('MeMbEr/My-Repo') });

            expect(
                (await works.findWorksUsingRepository('MEMBER', 'MY-REPO')).map((row) => row.id),
            ).toEqual([WORK_A]);
        });

        it('defaults to both kinds — and to nothing else', async () => {
            await seed(WORK_A, { kind: 'repo', data: role('member/my-repo') });
            await seed(WORK_B, { kind: 'app', website: role('member/my-repo') });
            // A kind outside the default pair, carrying the same coordinates.
            await seed(WORK_C, { kind: 'website', data: role('member/my-repo') });

            const found = await works.findWorksUsingRepository('member', 'my-repo');

            expect(found.map((row) => row.kind).sort()).toEqual(['app', 'repo']);
        });

        it('honours a narrower `kinds` list in both directions', async () => {
            await seed(WORK_A, { kind: 'repo', data: role('member/my-repo') });
            await seed(WORK_B, { kind: 'app', website: role('member/my-repo') });

            const onlyRepo = await works.findWorksUsingRepository('member', 'my-repo', {
                kinds: ['repo'],
            });
            expect(onlyRepo.map((row) => [row.kind, row.relation])).toEqual([['repo', 'data']]);

            const onlyApp = await works.findWorksUsingRepository('member', 'my-repo', {
                kinds: ['app'],
            });
            expect(onlyApp.map((row) => [row.kind, row.relation])).toEqual([['app', 'website']]);
        });

        it('never matches the role the kind does not use', async () => {
            // A `repo` Work whose *website* role points at the repository: for
            // that kind the wrapped repository is `data`
            // (`applyRepositoryWorkSource`).
            await seed(WORK_A, { kind: 'repo', website: role('member/my-repo') });
            // An App Work whose *data* role points at it: an App Work's code is
            // its Work Repository (`website`, plan.md:240).
            await seed(WORK_B, { kind: 'app', data: role('member/my-repo') });

            expect(await works.findWorksUsingRepository('member', 'my-repo')).toEqual([]);
        });

        it('never matches a row whose role is missing or blank', async () => {
            await seed(WORK_A, { kind: 'repo' });
            await seed(WORK_B, { kind: 'app' });
            await seed(WORK_C, { kind: 'repo', data: { owner: '', repo: 'my-repo' } });
            await seed(WORK_D, { kind: 'app', website: { owner: 'member', repo: '' } });

            expect(await works.findWorksUsingRepository('member', 'my-repo')).toEqual([]);
        });

        it('carries the owning account on every row, so a caller can skip its own Work', async () => {
            await seed(WORK_A, { kind: 'repo', userId: USER_A, data: role('member/my-repo') });
            await seed(WORK_B, { kind: 'repo', userId: USER_B, data: role('member/my-repo') });

            const found = await works.findWorksUsingRepository('member', 'my-repo');

            expect(found.map((row) => row.userId).sort()).toEqual([USER_A, USER_B]);
        });

        it('narrows the candidate set by the indexed `owner` column', async () => {
            // `works.owner` IS the code repository's owner for both kinds
            // (plan.md:234 / plan.md:240) and the create/update paths keep it
            // equal to the role's owner, so this narrowing cannot hide a real
            // conflict — it is what keeps the scan off a full table read.
            await seed(WORK_A, {
                kind: 'repo',
                owner: 'somebody-else',
                data: role('member/my-repo'),
            });

            expect(await works.findWorksUsingRepository('member', 'my-repo')).toEqual([]);
        });

        it('answers [] for a blank owner or repo, or an empty `kinds` list', async () => {
            await seed(WORK_A, { kind: 'repo', data: role('member/my-repo') });

            expect(await works.findWorksUsingRepository('', 'my-repo')).toEqual([]);
            expect(await works.findWorksUsingRepository('member', '')).toEqual([]);
            expect(
                await works.findWorksUsingRepository('member', 'my-repo', { kinds: [] }),
            ).toEqual([]);
        });
    });

    describe('the SQL the two lookups emit', () => {
        interface FakeQuery {
            where: jest.Mock;
            andWhere: jest.Mock;
            getMany: jest.Mock;
        }

        function buildQuery(rows: Work[]): {
            repository: Repository<Work>;
            query: FakeQuery;
            createQueryBuilder: jest.Mock;
        } {
            const query = {
                where: jest.fn(),
                andWhere: jest.fn(),
                getMany: jest.fn().mockResolvedValue(rows),
            } as FakeQuery;
            query.where.mockReturnValue(query);
            query.andWhere.mockReturnValue(query);
            const createQueryBuilder = jest.fn().mockReturnValue(query);
            return {
                repository: { createQueryBuilder } as unknown as Repository<Work>,
                query,
                createQueryBuilder,
            };
        }

        it('findAppWorksByDataRepository narrows in SQL to `kind = app` for one user', async () => {
            const { repository, query, createQueryBuilder } = buildQuery([]);

            await new WorkRepository(repository).findAppWorksByDataRepository(
                USER_A,
                'member',
                'my-app',
            );

            expect(createQueryBuilder).toHaveBeenCalledWith('work');
            expect(query.where).toHaveBeenCalledWith('work.kind = :kind', { kind: 'app' });
            expect(query.andWhere).toHaveBeenCalledWith('work.userId = :userId', {
                userId: USER_A,
            });
        });

        it('findAppWorksByDataRepository decides the match in memory, from `website`', async () => {
            // The `simple-json` column cannot be filtered portably in SQL, so
            // this is the half that decides the match — and it must read
            // `website`, never `data`.
            const row = {
                id: WORK_A,
                sourceRepository: {
                    relatedRepositories: {
                        website: role('member/my-app'),
                        data: role('member/somewhere-else'),
                    },
                },
            } as Work;
            const { repository } = buildQuery([row]);

            expect(
                (
                    await new WorkRepository(repository).findAppWorksByDataRepository(
                        USER_A,
                        'member',
                        'my-app',
                    )
                ).map((work) => work.id),
            ).toEqual([WORK_A]);
        });

        it('findWorksUsingRepository narrows in SQL by the kind list and a lowercased owner', async () => {
            const { repository, query, createQueryBuilder } = buildQuery([]);

            await new WorkRepository(repository).findWorksUsingRepository('Member', 'My-Repo');

            expect(createQueryBuilder).toHaveBeenCalledWith('work');
            expect(query.where).toHaveBeenCalledWith('work.kind IN (:...kinds)', {
                kinds: ['repo', 'app'],
            });
            expect(query.andWhere).toHaveBeenCalledWith('LOWER(work.owner) = :owner', {
                owner: 'member',
            });
        });

        it('findWorksUsingRepository passes a narrower kind list through unchanged', async () => {
            const { repository, query } = buildQuery([]);

            await new WorkRepository(repository).findWorksUsingRepository('member', 'my-repo', {
                kinds: ['app'],
            });

            expect(query.where).toHaveBeenCalledWith('work.kind IN (:...kinds)', {
                kinds: ['app'],
            });
        });

        it('both lookups answer a blank input without querying at all', async () => {
            const { repository, createQueryBuilder } = buildQuery([]);
            const scoped = new WorkRepository(repository);

            expect(await scoped.findAppWorksByDataRepository(USER_A, '', 'my-app')).toEqual([]);
            expect(await scoped.findAppWorksByDataRepository(USER_A, 'member', '')).toEqual([]);
            expect(await scoped.findWorksUsingRepository('', 'my-repo')).toEqual([]);
            expect(await scoped.findWorksUsingRepository('member', '')).toEqual([]);
            expect(
                await scoped.findWorksUsingRepository('member', 'my-repo', { kinds: [] }),
            ).toEqual([]);

            expect(createQueryBuilder).not.toHaveBeenCalled();
        });
    });

    describe('withTransaction', () => {
        const user = { id: USER_A } as User;

        it('delegates to the injected repository’s transaction, handing it the callback', async () => {
            const transaction = jest.fn().mockResolvedValue('done');
            const repository = { manager: { transaction } } as unknown as Repository<Work>;
            const callback = async () => 'done';

            await expect(new WorkRepository(repository).withTransaction(callback)).resolves.toBe(
                'done',
            );
            expect(transaction).toHaveBeenCalledWith(callback);
        });

        it('commits the Work written inside the callback', async () => {
            const created = await works.withTransaction((manager) =>
                works.create(
                    {
                        userId: USER_A,
                        name: 'Committed App',
                        slug: 'committed-app',
                        description: '',
                        owner: 'member',
                    },
                    user,
                    manager,
                ),
            );

            expect(created.slug).toBe('committed-app');
            expect(await works.findById(created.id)).not.toBeNull();
        });

        it('rolls the Work back when the callback throws', async () => {
            const createdIds: string[] = [];

            await expect(
                works.withTransaction(async (manager) => {
                    const created = await works.create(
                        {
                            userId: USER_A,
                            name: 'Rolled Back App',
                            slug: 'rolled-back-app',
                            description: '',
                            owner: 'member',
                        },
                        user,
                        manager,
                    );
                    createdIds.push(created.id);
                    throw new Error('rollback');
                }),
            ).rejects.toThrow('rollback');

            expect(createdIds).toHaveLength(1);
            expect(await works.findById(createdIds[0])).toBeNull();
        });
    });

    describe('manager-aware create', () => {
        const user = { id: USER_A } as User;

        function fakeRepository() {
            return {
                create: jest.fn(),
                save: jest.fn(),
                findOne: jest.fn(),
                createQueryBuilder: jest.fn(),
            };
        }

        it('routes the insert, the save and the re-read through the manager it is handed', async () => {
            const injected = fakeRepository();
            const transaction = fakeRepository();
            const created = { owner: 'member', slug: 'my-app' } as Work;
            const stored = { id: WORK_A, name: 'My App' } as Work;
            // The pooled repository is a *working* single-connection path that
            // simply cannot see the row the open transaction has not committed
            // — its re-read answers `null`, which is the Postgres symptom the
            // `manager` argument exists to avoid. A caller that ignored the
            // manager would return that `null` for the row it just inserted.
            injected.findOne.mockResolvedValue(null);
            injected.create.mockReturnValue(created);
            injected.save.mockResolvedValue({ id: WORK_A } as Work);
            transaction.create.mockReturnValue(created);
            transaction.save.mockResolvedValue({ id: WORK_A } as Work);
            transaction.findOne.mockResolvedValue(stored);
            const manager = { getRepository: jest.fn().mockReturnValue(transaction) };

            const result = await new WorkRepository(injected as unknown as Repository<Work>).create(
                { owner: 'member', slug: 'my-app' },
                user,
                manager as unknown as EntityManager,
            );

            expect(result).toBe(stored);
            // The duplicate check keeps its previous scope: it reads through
            // the injected repository, and it ran before anything was written.
            expect(injected.findOne).toHaveBeenCalledTimes(1);
            expect(injected.findOne).toHaveBeenCalledWith({
                where: { userId: USER_A, owner: 'member', slug: 'my-app' },
                relations: ['user'],
            });
            // Everything that writes, and the re-read that must see the
            // uncommitted row, runs on the transaction's connection.
            expect(manager.getRepository).toHaveBeenCalledWith(Work);
            expect(transaction.create).toHaveBeenCalledWith({ owner: 'member', slug: 'my-app' });
            expect(transaction.save).toHaveBeenCalledWith(created);
            expect(transaction.findOne).toHaveBeenCalledWith({
                where: { id: WORK_A },
                relations: ['user'],
            });
            expect(injected.create).not.toHaveBeenCalled();
            expect(injected.save).not.toHaveBeenCalled();
        });

        it('refuses a duplicate before any write, manager or not', async () => {
            const injected = fakeRepository();
            const transaction = fakeRepository();
            injected.findOne.mockResolvedValue({ id: WORK_A } as Work);
            const manager = { getRepository: jest.fn().mockReturnValue(transaction) };

            await expect(
                new WorkRepository(injected as unknown as Repository<Work>).create(
                    { owner: 'member', slug: 'my-app' },
                    user,
                    manager as unknown as EntityManager,
                ),
            ).rejects.toThrow('Work already exists');

            // The duplicate check reads through the injected repository, as it
            // always has, and nothing is written anywhere when it finds a row.
            expect(injected.findOne).toHaveBeenCalledWith({
                where: { userId: USER_A, owner: 'member', slug: 'my-app' },
                relations: ['user'],
            });
            expect(transaction.create).not.toHaveBeenCalled();
            expect(transaction.save).not.toHaveBeenCalled();
            expect(injected.create).not.toHaveBeenCalled();
            expect(injected.save).not.toHaveBeenCalled();
        });

        it('keeps the pooled path when no manager is given — existing callers are unchanged', async () => {
            const injected = fakeRepository();
            injected.findOne
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ id: WORK_A, name: 'My App' } as Work);
            injected.create.mockReturnValue({ owner: 'member', slug: 'my-app' } as Work);
            injected.save.mockResolvedValue({ id: WORK_A } as Work);

            await expect(
                new WorkRepository(injected as unknown as Repository<Work>).create(
                    { owner: 'member', slug: 'my-app' },
                    user,
                ),
            ).resolves.toEqual({ id: WORK_A, name: 'My App' });

            expect(injected.create).toHaveBeenCalledTimes(1);
            expect(injected.save).toHaveBeenCalledTimes(1);
        });
    });

    describe('WorkUpstreamStateRepository.create with a manager', () => {
        const user = { id: USER_A } as User;
        const stateInput = (workId: string) => ({
            workId,
            relation: 'fork' as const,
            dataOwner: 'member',
            dataRepo: 'my-app',
            dataDefaultBranch: 'main',
        });

        it('writes the state row on the same transaction as the Work row', async () => {
            const states = new WorkUpstreamStateRepository(
                dataSource.getRepository(WorkUpstreamState),
            );

            const created = await works.withTransaction(async (manager) => {
                const work = await works.create(
                    {
                        userId: USER_A,
                        name: 'App Work',
                        slug: 'app-work',
                        description: '',
                        owner: 'member',
                    },
                    user,
                    manager,
                );
                await states.create(stateInput(work.id), manager);
                return work;
            });

            expect(await works.findById(created.id)).not.toBeNull();
            expect(
                await dataSource
                    .getRepository(WorkUpstreamState)
                    .findOne({ where: { workId: created.id } }),
            ).not.toBeNull();
        });

        it('rolls the state row back with the transaction that wrote it', async () => {
            const states = new WorkUpstreamStateRepository(
                dataSource.getRepository(WorkUpstreamState),
            );

            await expect(
                works.withTransaction(async (manager) => {
                    await states.create(stateInput(WORK_A), manager);
                    throw new Error('rollback');
                }),
            ).rejects.toThrow('rollback');

            expect(
                await dataSource
                    .getRepository(WorkUpstreamState)
                    .findOne({ where: { workId: WORK_A } }),
            ).toBeNull();
        });

        it('writes the per-relation columns the create path passes, in that same row', async () => {
            // plan §4.2 step 10: a `link` has no upstream and hygiene never
            // touches it, so its row is created with both values rather than
            // patched into them by a second UPDATE.
            const states = new WorkUpstreamStateRepository(
                dataSource.getRepository(WorkUpstreamState),
            );

            await states.create({
                ...stateInput(WORK_A),
                relation: 'link',
                upstreamStatus: 'none',
                actionsState: 'not_applicable',
                readinessReason: 'linked_repository',
                dataRepositoryStatus: 'missing',
            });

            const stored = await dataSource
                .getRepository(WorkUpstreamState)
                .findOneOrFail({ where: { workId: WORK_A } });
            expect(stored.upstreamStatus).toBe('none');
            expect(stored.actionsState).toBe('not_applicable');
            expect(stored.readinessReason).toBe('linked_repository');
            expect(stored.dataRepositoryStatus).toBe('missing');
        });

        it('falls back to the column defaults for a caller that omits them', async () => {
            const states = new WorkUpstreamStateRepository(
                dataSource.getRepository(WorkUpstreamState),
            );

            await states.create(stateInput(WORK_B));

            const stored = await dataSource
                .getRepository(WorkUpstreamState)
                .findOneOrFail({ where: { workId: WORK_B } });
            // The declared column defaults — an existing caller sees no change.
            expect(stored.upstreamStatus).toBe('unknown');
            expect(stored.actionsState).toBe('pending');
            expect(stored.readinessReason ?? null).toBeNull();
            expect(stored.dataRepositoryStatus).toBe('available');
        });
    });
});
