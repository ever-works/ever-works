import type { Repository, SelectQueryBuilder, Brackets } from 'typeorm';
import { ActivityLogRepository } from '../activity-log.repository';
import { ActivityLog } from '../../../entities/activity-log.entity';
import {
    ActivityActionType,
    ActivityStatus,
} from '../../../entities/activity-log.types';

type Mocked = jest.Mocked<
    Pick<
        Repository<ActivityLog>,
        'create' | 'save' | 'update' | 'findOne' | 'find' | 'count' | 'createQueryBuilder'
    >
>;

/**
 * Build a chainable query-builder mock that records every call to `where` /
 * `andWhere` / `orderBy` etc. and returns itself, then resolves the named
 * terminal method with the supplied value.
 */
function buildChain<TResult>(terminalName: string, terminalResolved: TResult) {
    const fns: Record<string, jest.Mock> = {};
    const chain: any = {};

    const passthroughMethods = [
        'where',
        'andWhere',
        'orWhere',
        'orderBy',
        'addOrderBy',
        'select',
        'addSelect',
        'leftJoinAndSelect',
        'skip',
        'take',
        'groupBy',
    ];

    for (const m of passthroughMethods) {
        fns[m] = jest.fn(() => chain);
        chain[m] = fns[m];
    }

    fns[terminalName] = jest.fn().mockResolvedValue(terminalResolved);
    chain[terminalName] = fns[terminalName];

    return { chain, fns };
}

describe('ActivityLogRepository', () => {
    let repository: Mocked;
    let service: ActivityLogRepository;

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            count: jest.fn(),
            createQueryBuilder: jest.fn(),
        };
        service = new ActivityLogRepository(
            repository as unknown as Repository<ActivityLog>,
        );
    });

    describe('create', () => {
        it('creates and saves the entry verbatim', async () => {
            const created = {} as ActivityLog;
            const saved = { id: 'a1' } as ActivityLog;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const dto = {
                userId: 'u1',
                actionType: ActivityActionType.WORK_CREATED,
                action: 'work.created',
                status: ActivityStatus.COMPLETED,
                summary: 'Created work',
            };

            await expect(service.create(dto)).resolves.toBe(saved);

            expect(repository.create).toHaveBeenCalledWith(dto);
            expect(repository.save).toHaveBeenCalledWith(created);
        });
    });

    describe('update', () => {
        it('updates by id then refetches via findById (so the returned row reflects post-update state)', async () => {
            const refetched = { id: 'a1', status: ActivityStatus.COMPLETED } as ActivityLog;
            repository.update.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(refetched);

            const result = await service.update('a1', {
                status: ActivityStatus.COMPLETED,
            });

            expect(result).toBe(refetched);
            expect(repository.update).toHaveBeenCalledWith('a1', {
                status: ActivityStatus.COMPLETED,
            });
            // findById refetches with the work relation joined
            expect(repository.findOne).toHaveBeenCalledWith({
                where: { id: 'a1' },
                relations: ['work'],
            });
        });

        it('returns null when the row vanished between update and refetch', async () => {
            repository.update.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(null);

            await expect(service.update('a1', {})).resolves.toBeNull();
        });
    });

    describe('findById', () => {
        it('joins the work relation', async () => {
            const row = { id: 'a1' } as ActivityLog;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findById('a1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { id: 'a1' },
                relations: ['work'],
            });
        });

        it('returns null when not found', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findById('missing')).resolves.toBeNull();
        });
    });

    describe('findByIdAndUserId', () => {
        it('queries by composite (id, userId) for cross-user 404 safety + joins work', async () => {
            const row = { id: 'a1' } as ActivityLog;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findByIdAndUserId('a1', 'u1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { id: 'a1', userId: 'u1' },
                relations: ['work'],
            });
        });
    });

    describe('findLatestByUserWorkActionStatus', () => {
        it('queries by all four discriminator fields ordered DESC and joins the work relation (used by reconcileActivities to merge in-progress GENERATION rows)', async () => {
            const row = { id: 'a1' } as ActivityLog;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(
                service.findLatestByUserWorkActionStatus({
                    userId: 'u1',
                    workId: 'w1',
                    actionType: ActivityActionType.GENERATION,
                    status: ActivityStatus.IN_PROGRESS,
                }),
            ).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: {
                    userId: 'u1',
                    workId: 'w1',
                    actionType: ActivityActionType.GENERATION,
                    status: ActivityStatus.IN_PROGRESS,
                },
                order: { createdAt: 'DESC' },
                relations: ['work'],
            });
        });
    });

    describe('findInProgressGenerationsByUserId', () => {
        it('hard-codes generation + in_progress as string casts (NOT enum re-imports — pinned because the cast `as ActivityActionType` lets a future enum-rename break loudly while the wire value stays stable)', async () => {
            const rows = [{ id: 'a1' } as ActivityLog];
            repository.find.mockResolvedValueOnce(rows);

            await expect(
                service.findInProgressGenerationsByUserId('u1'),
            ).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({
                where: {
                    userId: 'u1',
                    actionType: 'generation',
                    status: 'in_progress',
                },
                order: { createdAt: 'DESC' },
            });
        });
    });

    describe('findByUserId / findByUserIdForExport', () => {
        it('default options: builds the base query (userId where, work join, ORDER BY createdAt DESC, take=25, skip=0) when only userId is provided', async () => {
            const { chain, fns } = buildChain<[ActivityLog[], number]>(
                'getManyAndCount',
                [[{ id: 'a1' } as ActivityLog], 1],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            await expect(service.findByUserId({ userId: 'u1' })).resolves.toEqual({
                activities: [{ id: 'a1' }],
                total: 1,
            });

            expect(repository.createQueryBuilder).toHaveBeenCalledWith('activity');
            expect(fns.leftJoinAndSelect).toHaveBeenCalledWith('activity.work', 'work');
            expect(fns.where).toHaveBeenCalledWith('activity.userId = :userId', {
                userId: 'u1',
            });
            expect(fns.orderBy).toHaveBeenCalledWith('activity.createdAt', 'DESC');
            // No optional filters fired
            expect(fns.andWhere).not.toHaveBeenCalled();
            expect(fns.take).toHaveBeenCalledWith(25);
            expect(fns.skip).toHaveBeenCalledWith(0);
        });

        it('forwards every optional filter (actionType / workId / status / dateFrom / dateTo) when provided', async () => {
            const { chain, fns } = buildChain<[ActivityLog[], number]>(
                'getManyAndCount',
                [[], 0],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            const dateFrom = new Date('2026-01-01T00:00:00Z');
            const dateTo = new Date('2026-02-01T00:00:00Z');

            await service.findByUserId({
                userId: 'u1',
                actionType: ActivityActionType.DEPLOYMENT,
                workId: 'w1',
                status: ActivityStatus.FAILED,
                dateFrom,
                dateTo,
            });

            expect(fns.andWhere).toHaveBeenCalledWith('activity.actionType = :actionType', {
                actionType: ActivityActionType.DEPLOYMENT,
            });
            expect(fns.andWhere).toHaveBeenCalledWith('activity.workId = :workId', {
                workId: 'w1',
            });
            expect(fns.andWhere).toHaveBeenCalledWith('activity.status = :status', {
                status: ActivityStatus.FAILED,
            });
            expect(fns.andWhere).toHaveBeenCalledWith('activity.createdAt >= :dateFrom', {
                dateFrom,
            });
            expect(fns.andWhere).toHaveBeenCalledWith('activity.createdAt <= :dateTo', {
                dateTo,
            });
        });

        it('skips the search Brackets when search trims to empty (`prepareCaseInsensitiveContainsPattern` returns undefined for whitespace-only)', async () => {
            const { chain, fns } = buildChain<[ActivityLog[], number]>(
                'getManyAndCount',
                [[], 0],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            await service.findByUserId({ userId: 'u1', search: '   ' });

            // Only the userId where; search Brackets is NOT registered when pattern is empty
            // (the Brackets would be passed as a single positional argument so the
            // andWhere variants with two args above would still fire if Brackets was
            // registered; here we just assert no andWhere with a Brackets fires).
            const bracketsCalls = fns.andWhere.mock.calls.filter(
                (call: unknown[]) => call.length === 1,
            );
            expect(bracketsCalls).toHaveLength(0);
        });

        it('registers a search Brackets with summary OR work.name LIKE clauses when the trimmed search is non-empty (lowercase + escaped + wrapped with `%`)', async () => {
            const { chain, fns } = buildChain<[ActivityLog[], number]>(
                'getManyAndCount',
                [[], 0],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            await service.findByUserId({ userId: 'u1', search: ' Hello%World ' });

            // Brackets is the only argument
            const bracketsCalls = fns.andWhere.mock.calls.filter(
                (call: unknown[]) => call.length === 1,
            );
            expect(bracketsCalls).toHaveLength(1);

            // Drive the Brackets factory through a sub-chain to capture the inner WHERE/orWHERE shape.
            const subFns: Record<string, jest.Mock> = {};
            const subChain: any = {};
            for (const m of ['where', 'orWhere']) {
                subFns[m] = jest.fn(() => subChain);
                subChain[m] = subFns[m];
            }
            const brackets = bracketsCalls[0][0] as Brackets;
            (brackets as any).whereFactory(subChain);

            expect(subFns.where).toHaveBeenCalledWith(
                expect.stringContaining('LOWER(activity.summary) LIKE :search'),
                { search: '%hello\\%world%' },
            );
            expect(subFns.orWhere).toHaveBeenCalledWith(
                expect.stringContaining('LOWER(work.name) LIKE :search'),
                { search: '%hello\\%world%' },
            );
        });

        it('caps requested limit at 100 (enforceCap=true via findByUserId) — passing limit:200 still calls take(100)', async () => {
            const { chain, fns } = buildChain<[ActivityLog[], number]>(
                'getManyAndCount',
                [[], 0],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            await service.findByUserId({ userId: 'u1', limit: 200, offset: 5 });

            expect(fns.take).toHaveBeenCalledWith(100);
            expect(fns.skip).toHaveBeenCalledWith(5);
        });

        it('limit:100 boundary stays at 100 (Math.min with itself)', async () => {
            const { chain, fns } = buildChain<[ActivityLog[], number]>(
                'getManyAndCount',
                [[], 0],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            await service.findByUserId({ userId: 'u1', limit: 100 });

            expect(fns.take).toHaveBeenCalledWith(100);
        });

        it('falsy limit (0 / undefined) → defaults to 25 via `options.limit || 25`', async () => {
            const { chain: chain1, fns: fns1 } = buildChain<[ActivityLog[], number]>(
                'getManyAndCount',
                [[], 0],
            );
            const { chain: chain2, fns: fns2 } = buildChain<[ActivityLog[], number]>(
                'getManyAndCount',
                [[], 0],
            );
            repository.createQueryBuilder
                .mockReturnValueOnce(chain1 as unknown as SelectQueryBuilder<ActivityLog>)
                .mockReturnValueOnce(chain2 as unknown as SelectQueryBuilder<ActivityLog>);

            await service.findByUserId({ userId: 'u1', limit: 0 });
            await service.findByUserId({ userId: 'u1' });

            expect(fns1.take).toHaveBeenCalledWith(25);
            expect(fns2.take).toHaveBeenCalledWith(25);
        });

        it('findByUserIdForExport unwraps to the activities array AND skips the 100-cap (enforceCap=false — limit:5000 is honoured verbatim, used by the controller for the 10 000-row CSV export ceiling)', async () => {
            const rows = [{ id: 'a1' } as ActivityLog, { id: 'a2' } as ActivityLog];
            const { chain, fns } = buildChain<[ActivityLog[], number]>(
                'getManyAndCount',
                [rows, rows.length],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            const result = await service.findByUserIdForExport({
                userId: 'u1',
                limit: 5000,
            });

            expect(result).toBe(rows);
            // Take is the user-supplied 5000 NOT capped to 100
            expect(fns.take).toHaveBeenCalledWith(5000);
        });
    });

    describe('countByStatus', () => {
        it('counts by composite (userId, status)', async () => {
            repository.count.mockResolvedValueOnce(7);

            await expect(
                service.countByStatus('u1', ActivityStatus.IN_PROGRESS),
            ).resolves.toBe(7);

            expect(repository.count).toHaveBeenCalledWith({
                where: { userId: 'u1', status: ActivityStatus.IN_PROGRESS },
            });
        });
    });

    describe('countByStatuses', () => {
        it('returns the full five-status grid initialised to 0 even when query returns nothing', async () => {
            const { chain, fns } = buildChain<unknown[]>('getRawMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            await expect(service.countByStatuses('u1')).resolves.toEqual({
                pending: 0,
                in_progress: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
            });

            expect(repository.createQueryBuilder).toHaveBeenCalledWith('activity');
            expect(fns.select).toHaveBeenCalledWith('activity.status', 'status');
            expect(fns.addSelect).toHaveBeenCalledWith('COUNT(*)', 'count');
            expect(fns.where).toHaveBeenCalledWith('activity.userId = :userId', {
                userId: 'u1',
            });
            expect(fns.groupBy).toHaveBeenCalledWith('activity.status');
        });

        it('coerces string counts into numbers (raw SQL returns strings on Postgres) and merges into the grid', async () => {
            const { chain } = buildChain<{ status: ActivityStatus; count: string }[]>(
                'getRawMany',
                [
                    { status: ActivityStatus.COMPLETED, count: '10' },
                    { status: ActivityStatus.FAILED, count: '3' },
                    { status: ActivityStatus.IN_PROGRESS, count: '1' },
                ],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            await expect(service.countByStatuses('u1')).resolves.toEqual({
                pending: 0,
                in_progress: 1,
                completed: 10,
                failed: 3,
                cancelled: 0,
            });
        });

        it('non-numeric count strings coerce to 0 via `Number(count) || 0`', async () => {
            const { chain } = buildChain<{ status: ActivityStatus; count: string }[]>(
                'getRawMany',
                [{ status: ActivityStatus.COMPLETED, count: 'NaN' }],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            await expect(service.countByStatuses('u1')).resolves.toMatchObject({
                completed: 0,
            });
        });

        it('handles unknown status values by adding them to the grid (current behaviour pin — `counts[row.status] = ...` does not pre-validate)', async () => {
            const { chain } = buildChain<{ status: ActivityStatus; count: string }[]>(
                'getRawMany',
                [{ status: 'unknown' as ActivityStatus, count: '4' }],
            );
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<ActivityLog>,
            );

            const result = await service.countByStatuses('u1');
            expect((result as Record<string, number>)['unknown']).toBe(4);
            // Existing grid unchanged
            expect(result).toMatchObject({
                pending: 0,
                in_progress: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
            });
        });
    });
});
