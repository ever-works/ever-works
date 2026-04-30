import { DirectoryScheduleRepository } from './directory-schedule.repository';
import { DirectorySchedule } from '@src/entities/directory-schedule.entity';
import { DirectoryScheduleStatus, GenerateStatusType } from '@src/entities/types';

describe('DirectoryScheduleRepository', () => {
    let repository: {
        findOne: jest.Mock;
        upsert: jest.Mock;
        createQueryBuilder: jest.Mock;
    };
    let queryBuilder: {
        update: jest.Mock;
        set: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        execute: jest.Mock;
    };
    let scheduleRepository: DirectoryScheduleRepository;

    beforeEach(() => {
        queryBuilder = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: jest.fn(),
        };

        repository = {
            findOne: jest.fn(),
            upsert: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        };

        scheduleRepository = new DirectoryScheduleRepository(repository as any);
    });

    it('uses a Date value for lastRunAt when marking a schedule dispatched', async () => {
        const nextRunAt = new Date('2026-04-11T15:55:12.034Z');

        repository.findOne.mockResolvedValue({
            id: 'schedule-1',
            nextRunAt,
        });
        queryBuilder.execute.mockResolvedValue({ affected: 1 });

        const result = await scheduleRepository.tryMarkDispatched('schedule-1');

        expect(queryBuilder.update).toHaveBeenCalledWith(DirectorySchedule);
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
        expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', { id: 'schedule-1' });
        expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(1, 'status = :status', {
            status: DirectoryScheduleStatus.ACTIVE,
        });
        expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(2, 'nextRunAt = :nextRunAt', {
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

    it('uses database-native upsert by directoryId', async () => {
        repository.upsert.mockResolvedValue(undefined);
        repository.findOne.mockResolvedValue({ id: 'schedule-1', directoryId: 'dir-1' });

        await scheduleRepository.upsert('dir-1', {
            userId: 'user-1',
            status: DirectoryScheduleStatus.ACTIVE,
        } as any);

        expect(repository.upsert).toHaveBeenCalledWith(
            {
                directoryId: 'dir-1',
                userId: 'user-1',
                status: DirectoryScheduleStatus.ACTIVE,
            },
            ['directoryId'],
        );
    });
});
