import { WorkScheduleRepository } from './work-schedule.repository';
import { WorkSchedule } from '@src/entities/work-schedule.entity';
import { WorkScheduleStatus, GenerateStatusType } from '@src/entities/types';

describe('WorkScheduleRepository', () => {
    let repository: {
        findOne: jest.Mock;
        upsert: jest.Mock;
        createQueryBuilder: jest.Mock;
    };
    let queryBuilder: {
        leftJoinAndSelect: jest.Mock;
        select: jest.Mock;
        update: jest.Mock;
        set: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        orderBy: jest.Mock;
        take: jest.Mock;
        getMany: jest.Mock;
        getOne: jest.Mock;
        execute: jest.Mock;
    };
    let scheduleRepository: WorkScheduleRepository;

    beforeEach(() => {
        queryBuilder = {
            leftJoinAndSelect: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            getMany: jest.fn(),
            getOne: jest.fn(),
            execute: jest.fn(),
        };

        repository = {
            findOne: jest.fn(),
            upsert: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        };

        scheduleRepository = new WorkScheduleRepository(repository as any);
    });

    it('uses a Date value for lastRunAt when marking a schedule dispatched', async () => {
        const nextRunAt = new Date('2026-04-11T15:55:12.034Z');

        repository.findOne.mockResolvedValue({
            id: 'schedule-1',
            nextRunAt,
        });
        queryBuilder.execute.mockResolvedValue({ affected: 1 });

        const result = await scheduleRepository.tryMarkDispatched('schedule-1');

        expect(queryBuilder.update).toHaveBeenCalledWith(WorkSchedule);
        expect(queryBuilder.set).toHaveBeenCalledTimes(1);

        const setPayload = queryBuilder.set.mock.calls[0][0];

        expect(setPayload).toEqual(
            expect.objectContaining({
                lastRunStatus: GenerateStatusType.GENERATING,
                scheduledFor: nextRunAt,
                nextRunAt: null,
                lastRunAt: expect.any(Date),
                updatedAt: expect.any(Date),
            }),
        );
        expect(setPayload.lastRunAt).toBe(setPayload.updatedAt);
        expect(queryBuilder.where).toHaveBeenCalledWith({
            id: 'schedule-1',
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt,
        });
        expect(result).toBe(nextRunAt);
    });

    it('returns null when the schedule is already claimed', async () => {
        repository.findOne.mockResolvedValue({
            id: 'schedule-1',
            nextRunAt: new Date('2026-04-11T15:55:12.034Z'),
        });
        queryBuilder.execute.mockResolvedValue({ affected: 0 });

        const result = await scheduleRepository.tryMarkDispatched('schedule-1');

        expect(result).toBeNull();
    });

    it('uses database-native upsert by workId', async () => {
        repository.upsert.mockResolvedValue(undefined);
        repository.findOne.mockResolvedValue({ id: 'schedule-1', workId: 'dir-1' });

        await scheduleRepository.upsert('dir-1', {
            userId: 'user-1',
            status: WorkScheduleStatus.ACTIVE,
        } as any);

        expect(repository.upsert).toHaveBeenCalledWith(
            {
                workId: 'dir-1',
                userId: 'user-1',
                status: WorkScheduleStatus.ACTIVE,
            },
            ['workId'],
        );
    });

    it('findDue selects the dispatch fields through a query builder without loading schedule.user', async () => {
        const rows = [{ id: 'schedule-1' }] as WorkSchedule[];
        queryBuilder.getMany.mockResolvedValue(rows);

        await expect(scheduleRepository.findDue(25)).resolves.toBe(rows);

        expect(repository.createQueryBuilder).toHaveBeenCalledWith('schedule');
        expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith('schedule.work', 'work');
        expect(queryBuilder.select).toHaveBeenCalledWith(
            expect.arrayContaining([
                'schedule.id',
                'schedule.workId',
                'schedule.userId',
                'work.id',
                'work.name',
                'work.slug',
                'work.sourceRepository',
            ]),
        );
        expect(queryBuilder.where).toHaveBeenCalledWith({
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt: expect.any(Object),
        });
        expect(queryBuilder.orderBy).toHaveBeenCalledWith('schedule.nextRunAt', 'ASC');
        expect(queryBuilder.take).toHaveBeenCalledWith(25);
    });

    it('findByIdForDispatch selects schedule and work fields without loading schedule.user', async () => {
        const row = { id: 'schedule-1' } as WorkSchedule;
        queryBuilder.getOne.mockResolvedValue(row);

        await expect(scheduleRepository.findByIdForDispatch('schedule-1')).resolves.toBe(row);

        expect(repository.createQueryBuilder).toHaveBeenCalledWith('schedule');
        expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith('schedule.work', 'work');
        expect(queryBuilder.select).toHaveBeenCalledWith(
            expect.arrayContaining([
                'schedule.id',
                'schedule.workId',
                'schedule.userId',
                'work.id',
                'work.name',
                'work.slug',
                'work.sourceRepository',
            ]),
        );
        expect(queryBuilder.where).toHaveBeenCalledWith({ id: 'schedule-1' });
    });
});
