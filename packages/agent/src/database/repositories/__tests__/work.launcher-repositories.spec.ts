import type { Repository, SelectQueryBuilder } from 'typeorm';
import { Brackets, DataSource } from 'typeorm';
import { DeploymentEnvironment, WorkDeployment } from '../../../entities/work-deployment.entity';
import { WorkCustomDomain } from '../../../entities/work-custom-domain.entity';
import { User } from '../../../entities/user.entity';
import { Work } from '../../../entities/work.entity';
import { ENTITIES } from '../../_entities-inventory';
import { WorkCustomDomainRepository } from '../work-custom-domain.repository';
import { WorkDeploymentRepository } from '../work-deployment.repository';
import { LAUNCHER_CANDIDATE_LIMIT_MAX, WorkRepository } from '../work.repository';

/**
 * APW-11 T5 — the three new reads the launcher's candidate set is built from
 * (plan §4.1 step 3), plus the pin that the read they sit beside is unchanged.
 *
 * Each method is asserted twice, on purpose:
 *
 *   - **executed** against a real in-memory better-sqlite3 database, so the
 *     filters and the ordering are the ones the query actually performs — a
 *     mocked query builder cannot catch a predicate that is emitted but wrong;
 *   - **shaped** through a mocked query builder, so the SQL the pinned plan
 *     specifies (`updatedAt DESC`, `(createdAt DESC, id DESC)`,
 *     `state = 'READY'`, `createdAt ASC`) cannot be changed silently later.
 *
 * `findLatestForWorks` is the read APW-11 was told to sit *next to*, not to
 * change: its own tests in `work-deployment.repository.spec.ts` still apply, and
 * this file adds the check that its subquery gained no state filter.
 *
 * Every uuid is obviously synthetic; no host or address appears.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('APW-11 launcher reads on the Work repositories', () => {
    let dataSource: DataSource;

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
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    let seq = 0;
    async function makeWork(
        userId: string,
        options: { organizationId?: string | null; status?: string } = {},
    ): Promise<string> {
        seq += 1;
        const works = dataSource.getRepository(Work);
        const saved = await works.save(
            works.create({
                userId,
                name: `Work ${seq}`,
                slug: `work-${seq}`,
                description: `Launcher fixture ${seq}`,
                status: options.status ?? 'active',
                organizationId: options.organizationId ?? null,
            } as Partial<Work>),
        );
        return saved.id;
    }

    /** Pin a row's `updatedAt`, which is the candidate read's `ORDER BY`. */
    const stampWork = (id: string, iso: string) =>
        dataSource.query(`UPDATE "works" SET "updatedAt" = ? WHERE "id" = ?`, [iso, id]);

    beforeEach(async () => {
        await dataSource.query('DELETE FROM "work_deployments"');
        await dataSource.query('DELETE FROM "work_custom_domains"');
        await dataSource.query('DELETE FROM "works"');
    });

    describe('WorkRepository.findLauncherCandidates (executed)', () => {
        let works: WorkRepository;

        beforeAll(() => {
            works = new WorkRepository(dataSource.getRepository(Work));
        });

        it("returns the person's own Works and excludes everybody else's", async () => {
            const mine = await makeWork(USER);
            await makeWork(OTHER_USER);

            const candidates = await works.findLauncherCandidates({ userId: USER });

            expect(candidates.map((work) => work.id)).toEqual([mine]);
        });

        it('includes a Work the person is a member of (FR-17)', async () => {
            const shared = await makeWork(OTHER_USER);

            const candidates = await works.findLauncherCandidates({
                userId: USER,
                memberWorkIds: [shared],
            });

            expect(candidates.map((work) => work.id)).toEqual([shared]);
        });

        it('excludes an archived Work', async () => {
            const live = await makeWork(USER);
            await makeWork(USER, { status: 'archived' });

            const candidates = await works.findLauncherCandidates({ userId: USER });

            expect(candidates.map((work) => work.id)).toEqual([live]);
        });

        it('keeps a draft Work — status alone never hides a live address', async () => {
            const draft = await makeWork(USER, { status: 'draft' });

            const candidates = await works.findLauncherCandidates({ userId: USER });

            expect(candidates.map((work) => work.id)).toEqual([draft]);
        });

        it('never mixes two Organizations, and never mixes either with personal scope', async () => {
            const personal = await makeWork(USER);
            const inA = await makeWork(USER, { organizationId: ORG_A });
            const inB = await makeWork(USER, { organizationId: ORG_B });

            const forA = await works.findLauncherCandidates({
                userId: USER,
                organizationId: ORG_A,
            });
            expect(forA.map((work) => work.id)).toEqual([inA]);

            const forB = await works.findLauncherCandidates({
                userId: USER,
                organizationId: ORG_B,
            });
            expect(forB.map((work) => work.id)).toEqual([inB]);

            const forPersonal = await works.findLauncherCandidates({
                userId: USER,
                organizationId: null,
            });
            expect(forPersonal.map((work) => work.id)).toEqual([personal]);
        });

        it('orders by updatedAt DESC — the recency window the 500 cap cuts', async () => {
            const oldest = await makeWork(USER);
            const newest = await makeWork(USER);
            const middle = await makeWork(USER);
            await stampWork(oldest, '2026-01-01T00:00:00.000Z');
            await stampWork(newest, '2026-03-01T00:00:00.000Z');
            await stampWork(middle, '2026-02-01T00:00:00.000Z');

            const candidates = await works.findLauncherCandidates({ userId: USER });

            expect(candidates.map((work) => work.id)).toEqual([newest, middle, oldest]);
        });

        it('honours a smaller limit', async () => {
            await makeWork(USER);
            await makeWork(USER);
            await makeWork(USER);

            const candidates = await works.findLauncherCandidates({ userId: USER, limit: 2 });

            expect(candidates).toHaveLength(2);
        });

        it('returns nothing for a missing user, without querying', async () => {
            await makeWork(USER);

            expect(await works.findLauncherCandidates({ userId: '' })).toEqual([]);
        });
    });

    describe('WorkRepository.findLauncherCandidates — query shape', () => {
        function buildRepository() {
            const query = buildQueryBuilder<Work>();
            query.getMany.mockResolvedValue([]);
            const repository = {
                createQueryBuilder: jest.fn().mockReturnValue(query),
            } as unknown as Repository<Work>;
            return { repository, query };
        }

        it('asks for creator-or-member as one bracketed OR, not two ANDed predicates', async () => {
            const { repository, query } = buildRepository();
            const works = new WorkRepository(repository);

            await works.findLauncherCandidates({
                userId: USER,
                memberWorkIds: ['w1', 'w2'],
            });

            expect(query.where).toHaveBeenCalledTimes(1);
            expect(query.where.mock.calls[0][0]).toBeInstanceOf(Brackets);
        });

        it('asks for the creator alone when the person has no memberships', async () => {
            const { repository, query } = buildRepository();
            const works = new WorkRepository(repository);

            await works.findLauncherCandidates({ userId: USER });

            expect(query.where).toHaveBeenCalledWith('work.userId = :userId', { userId: USER });
        });

        it('excludes archived Works and orders by updatedAt DESC, id ASC', async () => {
            const { repository, query } = buildRepository();
            const works = new WorkRepository(repository);

            await works.findLauncherCandidates({ userId: USER });

            expect(query.andWhere).toHaveBeenCalledWith('work.status <> :archivedStatus', {
                archivedStatus: 'archived',
            });
            expect(query.orderBy).toHaveBeenCalledWith('work.updatedAt', 'DESC');
            expect(query.addOrderBy).toHaveBeenCalledWith('work.id', 'ASC');
        });

        it('scopes to the Organization, or to the personal scope when there is none', async () => {
            const forOrg = buildRepository();
            await new WorkRepository(forOrg.repository).findLauncherCandidates({
                userId: USER,
                organizationId: ORG_A,
            });
            expect(forOrg.query.andWhere).toHaveBeenCalledWith(
                'work.organizationId = :organizationId',
                { organizationId: ORG_A },
            );

            const forPersonal = buildRepository();
            await new WorkRepository(forPersonal.repository).findLauncherCandidates({
                userId: USER,
            });
            expect(forPersonal.query.andWhere).toHaveBeenCalledWith('work.organizationId IS NULL');
        });

        it('clamps the candidate cap to LAUNCHER_CANDIDATE_LIMIT_MAX (plan §4.1:374)', async () => {
            const asked = buildRepository();
            await new WorkRepository(asked.repository).findLauncherCandidates({
                userId: USER,
                limit: 25,
            });
            expect(asked.query.take).toHaveBeenCalledWith(25);

            const raised = buildRepository();
            await new WorkRepository(raised.repository).findLauncherCandidates({
                userId: USER,
                limit: 10_000,
            });
            expect(raised.query.take).toHaveBeenCalledWith(LAUNCHER_CANDIDATE_LIMIT_MAX);

            const omitted = buildRepository();
            await new WorkRepository(omitted.repository).findLauncherCandidates({ userId: USER });
            expect(omitted.query.take).toHaveBeenCalledWith(LAUNCHER_CANDIDATE_LIMIT_MAX);
        });

        it('does not join the user relation — a launcher tile never reads it', async () => {
            const { repository, query } = buildRepository();
            await new WorkRepository(repository).findLauncherCandidates({ userId: USER });

            expect(query.leftJoinAndSelect).not.toHaveBeenCalled();
        });
    });

    describe('WorkDeploymentRepository.findLatestReadyForWorks (executed)', () => {
        let deployments: WorkDeploymentRepository;

        beforeAll(() => {
            deployments = new WorkDeploymentRepository(dataSource.getRepository(WorkDeployment));
        });

        async function deploy(
            workId: string,
            state: string,
            environment: DeploymentEnvironment,
            createdAt: string,
        ): Promise<string> {
            const repository = dataSource.getRepository(WorkDeployment);
            const saved = await repository.save(
                repository.create({
                    workId,
                    environment,
                    provider: 'ever-works',
                    state,
                    website: 'https://deployed.example.test/',
                } as Partial<WorkDeployment>),
            );
            await dataSource.query(`UPDATE "work_deployments" SET "createdAt" = ? WHERE "id" = ?`, [
                createdAt,
                saved.id,
            ]);
            return saved.id;
        }

        it('returns the newest READY production row per Work', async () => {
            const workId = await makeWork(USER);
            await deploy(
                workId,
                'READY',
                DeploymentEnvironment.PRODUCTION,
                '2026-01-01T00:00:00.000Z',
            );
            const newestReady = await deploy(
                workId,
                'READY',
                DeploymentEnvironment.PRODUCTION,
                '2026-03-01T00:00:00.000Z',
            );

            const map = await deployments.findLatestReadyForWorks(
                [workId],
                DeploymentEnvironment.PRODUCTION,
            );

            expect(map.get(workId)?.id).toBe(newestReady);
        });

        it('skips a newer SUPERSEDED row (ACC-11-44)', async () => {
            const workId = await makeWork(USER);
            const ready = await deploy(
                workId,
                'READY',
                DeploymentEnvironment.PRODUCTION,
                '2026-01-01T00:00:00.000Z',
            );
            await deploy(
                workId,
                'SUPERSEDED',
                DeploymentEnvironment.PRODUCTION,
                '2026-03-01T00:00:00.000Z',
            );

            const map = await deployments.findLatestReadyForWorks(
                [workId],
                DeploymentEnvironment.PRODUCTION,
            );

            expect(map.get(workId)?.id).toBe(ready);
        });

        it('never treats a preview deployment as a live address (FR-15, ACC-11-13)', async () => {
            const workId = await makeWork(USER);
            await deploy(
                workId,
                'READY',
                DeploymentEnvironment.PREVIEW,
                '2026-03-01T00:00:00.000Z',
            );

            const map = await deployments.findLatestReadyForWorks(
                [workId],
                DeploymentEnvironment.PRODUCTION,
            );

            expect(map.has(workId)).toBe(false);
        });

        it.each(['ERROR', 'CANCELED', 'TIMEOUT', 'BUILDING'])(
            'never treats a %s row as live',
            async (state) => {
                const workId = await makeWork(USER);
                await deploy(
                    workId,
                    state,
                    DeploymentEnvironment.PRODUCTION,
                    '2026-03-01T00:00:00.000Z',
                );

                const map = await deployments.findLatestReadyForWorks(
                    [workId],
                    DeploymentEnvironment.PRODUCTION,
                );

                expect(map.has(workId)).toBe(false);
            },
        );

        it('keeps an earlier success visible when a later deploy failed (ACC-11-12)', async () => {
            const workId = await makeWork(USER);
            const ready = await deploy(
                workId,
                'READY',
                DeploymentEnvironment.PRODUCTION,
                '2026-01-01T00:00:00.000Z',
            );
            await deploy(
                workId,
                'ERROR',
                DeploymentEnvironment.PRODUCTION,
                '2026-03-01T00:00:00.000Z',
            );

            const map = await deployments.findLatestReadyForWorks(
                [workId],
                DeploymentEnvironment.PRODUCTION,
            );

            expect(map.get(workId)?.id).toBe(ready);
        });

        it('returns nothing for an empty Work list, without querying', async () => {
            expect(
                await deployments.findLatestReadyForWorks([], DeploymentEnvironment.PRODUCTION),
            ).toEqual(new Map());
        });
    });

    describe('WorkDeploymentRepository.findLatestReadyForWorks — query shape', () => {
        function buildRepository() {
            const subquery = buildQueryBuilder<WorkDeployment>();
            subquery.getQuery.mockReturnValue('(SELECT latest.id)');
            const query = buildQueryBuilder<WorkDeployment>();
            query.subQuery.mockReturnValue(subquery as never);
            query.getMany.mockResolvedValue([]);
            const repository = {
                createQueryBuilder: jest.fn().mockReturnValue(query),
            } as unknown as Repository<WorkDeployment>;
            return { repository, query, subquery };
        }

        it('filters the subquery to READY and picks (createdAt DESC, id DESC)', async () => {
            const { repository, query, subquery } = buildRepository();

            await new WorkDeploymentRepository(repository).findLatestReadyForWorks(
                ['w1'],
                DeploymentEnvironment.PRODUCTION,
            );

            expect(subquery.andWhere).toHaveBeenCalledWith(`latest.state = 'READY'`);
            expect(subquery.orderBy).toHaveBeenCalledWith('latest.createdAt', 'DESC');
            expect(subquery.addOrderBy).toHaveBeenCalledWith('latest.id', 'DESC');
            expect(subquery.limit).toHaveBeenCalledWith(1);
            expect(query.andWhere).toHaveBeenCalledWith('deployment.id = (SELECT latest.id)');
        });

        it('leaves findLatestForWorks without a state filter — its behaviour is unchanged', async () => {
            // The read APW-11 sits BESIDE. It answers "what happened most
            // recently", whatever the state, and the chip (FR-58) is built from
            // it; adding a READY filter here would silently drop a failed or
            // superseded latest row from that answer.
            const { repository, subquery } = buildRepository();

            await new WorkDeploymentRepository(repository).findLatestForWorks(
                ['w1'],
                DeploymentEnvironment.PRODUCTION,
            );

            expect(subquery.andWhere).toHaveBeenCalledTimes(1);
            // The parameter itself is supplied by the outer query; the subquery
            // only names it, which is why no second argument appears here.
            expect(subquery.andWhere).toHaveBeenCalledWith('latest.environment = :environment');
            expect(subquery.orderBy).toHaveBeenCalledWith('latest.createdAt', 'DESC');
            expect(subquery.addOrderBy).toHaveBeenCalledWith('latest.id', 'DESC');
        });
    });

    describe('WorkCustomDomainRepository.findVerifiedProductionForWorks (executed)', () => {
        let domains: WorkCustomDomainRepository;

        beforeAll(() => {
            domains = new WorkCustomDomainRepository(dataSource.getRepository(WorkCustomDomain));
        });

        async function addDomain(
            workId: string,
            domain: string,
            options: { verified?: boolean; environment?: string; createdAt?: string } = {},
        ): Promise<string> {
            const repository = dataSource.getRepository(WorkCustomDomain);
            const saved = await repository.save(
                repository.create({
                    workId,
                    domain,
                    verified: options.verified ?? true,
                    environment: options.environment ?? 'production',
                } as Partial<WorkCustomDomain>),
            );
            if (options.createdAt) {
                await dataSource.query(
                    `UPDATE "work_custom_domains" SET "createdAt" = ? WHERE "id" = ?`,
                    [options.createdAt, saved.id],
                );
            }
            return saved.id;
        }

        it('returns the verified production domains of every requested Work, oldest first', async () => {
            const workId = await makeWork(USER);
            const later = await addDomain(workId, 'second.example.test', {
                createdAt: '2026-03-01T00:00:00.000Z',
            });
            const earlier = await addDomain(workId, 'first.example.test', {
                createdAt: '2026-01-01T00:00:00.000Z',
            });

            const grouped = await domains.findVerifiedProductionForWorks([workId]);

            expect(grouped.get(workId)?.map((row) => row.id)).toEqual([earlier, later]);
        });

        it('excludes an unverified domain', async () => {
            const workId = await makeWork(USER);
            await addDomain(workId, 'unverified.example.test', { verified: false });

            const grouped = await domains.findVerifiedProductionForWorks([workId]);

            expect(grouped.has(workId)).toBe(false);
        });

        it('excludes a preview domain — and never offers it as a fallback (FR-15)', async () => {
            const workId = await makeWork(USER);
            await addDomain(workId, 'preview.example.test', { environment: 'preview' });

            const grouped = await domains.findVerifiedProductionForWorks([workId]);

            expect(grouped.has(workId)).toBe(false);
        });

        it('groups by Work and skips Works with no verified domain', async () => {
            const withDomain = await makeWork(USER);
            const withoutDomain = await makeWork(USER);
            const domainId = await addDomain(withDomain, 'shop.example.test');

            const grouped = await domains.findVerifiedProductionForWorks([
                withDomain,
                withoutDomain,
            ]);

            expect([...grouped.keys()]).toEqual([withDomain]);
            expect(grouped.get(withDomain)?.map((row) => row.id)).toEqual([domainId]);
        });

        it('returns nothing for an empty Work list, without querying', async () => {
            expect(await domains.findVerifiedProductionForWorks([])).toEqual(new Map());
        });
    });
});

/** Just enough of a SelectQueryBuilder for the shape assertions above. */
function buildQueryBuilder<TEntity>() {
    const query = {} as jest.Mocked<SelectQueryBuilder<TEntity>>;
    for (const method of [
        'select',
        'from',
        'where',
        'andWhere',
        'orderBy',
        'addOrderBy',
        'limit',
        'take',
        'skip',
        'leftJoinAndSelect',
        'setParameters',
    ] as const) {
        query[method] = jest.fn().mockReturnValue(query) as never;
    }
    query.subQuery = jest.fn() as never;
    query.getQuery = jest.fn() as never;
    query.getMany = jest.fn() as never;
    return query;
}
