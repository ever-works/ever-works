import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { WorkSchedule } from '@src/entities/work-schedule.entity';
import { WorkScheduleStatus, GenerateStatusType } from '@src/entities/types';

@Injectable()
export class WorkScheduleRepository {
    constructor(
        @InjectRepository(WorkSchedule)
        private readonly repository: Repository<WorkSchedule>,
    ) {}

    async findByWorkId(workId: string): Promise<WorkSchedule | null> {
        return this.repository.findOne({
            where: { workId },
            relations: ['work', 'user'],
        });
    }

    async upsert(workId: string, data: Partial<WorkSchedule>): Promise<WorkSchedule> {
        await this.repository.upsert(
            {
                workId,
                ...data,
            },
            ['workId'],
        );

        return this.findByWorkId(workId);
    }

    async findById(id: string): Promise<WorkSchedule | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['work', 'user'],
        });
    }

    async updateById(id: string, data: Partial<WorkSchedule>): Promise<void> {
        await this.repository.update(id, data);
    }

    async markRun(
        scheduleId: string,
        status: WorkScheduleStatus,
        lastRunStatus: GenerateStatusType,
        nextRunAt: Date | null,
    ) {
        const updateData: Partial<WorkSchedule> = {
            status,
            lastRunStatus,
            lastRunAt: new Date(),
            nextRunAt,
        };

        if (status === WorkScheduleStatus.ACTIVE) {
            updateData.failureCount = 0;
        }

        await this.repository.update(scheduleId, updateData);
    }

    async incrementFailure(scheduleId: string): Promise<void> {
        await this.repository.increment({ id: scheduleId }, 'failureCount', 1);
    }

    async findDue(limit: number): Promise<WorkSchedule[]> {
        return this.repository
            .createQueryBuilder('schedule')
            .leftJoinAndSelect('schedule.work', 'work')
            .select([
                'schedule.id',
                'schedule.workId',
                'schedule.userId',
                'schedule.cadence',
                'schedule.status',
                'schedule.billingMode',
                'schedule.nextRunAt',
                'schedule.lastRunAt',
                'schedule.lastRunStatus',
                'schedule.failureCount',
                'schedule.maxFailureBeforePause',
                'schedule.alwaysCreatePullRequest',
                'schedule.scheduledFor',
                'schedule.providerOverrides',
                'schedule.createdAt',
                'schedule.updatedAt',
                'work.id',
                'work.name',
                'work.slug',
                'work.userId',
                'work.owner',
                'work.sourceRepository',
            ])
            .where('schedule.status = :status', { status: WorkScheduleStatus.ACTIVE })
            .andWhere('schedule.nextRunAt <= :now', {
                now: Date.now(),
            })
            .orderBy('schedule.nextRunAt', 'ASC')
            .take(limit)
            .getMany();
    }

    async findByIdForDispatch(id: string): Promise<WorkSchedule | null> {
        return this.repository
            .createQueryBuilder('schedule')
            .leftJoinAndSelect('schedule.work', 'work')
            .select([
                'schedule.id',
                'schedule.workId',
                'schedule.userId',
                'schedule.cadence',
                'schedule.status',
                'schedule.billingMode',
                'schedule.nextRunAt',
                'schedule.lastRunAt',
                'schedule.lastRunStatus',
                'schedule.failureCount',
                'schedule.maxFailureBeforePause',
                'schedule.alwaysCreatePullRequest',
                'schedule.scheduledFor',
                'schedule.providerOverrides',
                'schedule.createdAt',
                'schedule.updatedAt',
                'work.id',
                'work.name',
                'work.slug',
                'work.userId',
                'work.owner',
                'work.sourceRepository',
            ])
            .where({ id })
            .getOne();
    }

    async findStuckGenerating(olderThan: Date): Promise<WorkSchedule[]> {
        return this.repository.find({
            where: {
                lastRunStatus: GenerateStatusType.GENERATING,
                updatedAt: LessThanOrEqual(olderThan),
            },
        });
    }

    async pause(scheduleId: string): Promise<void> {
        await this.repository.update(scheduleId, { status: WorkScheduleStatus.PAUSED });
    }

    /**
     * Atomically claim a schedule for dispatch.
     * Returns the original nextRunAt value if successful, or null if already claimed.
     *
     * The UPDATE verifies nextRunAt still matches the value read before claiming.
     * That avoids clearing a newer rescheduled value if another request updates
     * the schedule between the read and write.
     */
    async tryMarkDispatched(scheduleId: string): Promise<Date | null> {
        // Read the nextRunAt before clearing it so we can preserve it as scheduledFor
        const schedule = await this.repository.findOne({
            where: { id: scheduleId },
            select: ['id', 'nextRunAt'],
        });
        if (!schedule?.nextRunAt) {
            return null;
        }

        const originalNextRunAt = schedule.nextRunAt;
        const dispatchedAt = new Date();

        const result = await this.repository
            .createQueryBuilder()
            .update(WorkSchedule)
            .set({
                lastRunStatus: GenerateStatusType.GENERATING,
                scheduledFor: originalNextRunAt,
                nextRunAt: null,
                lastRunAt: dispatchedAt,
                updatedAt: dispatchedAt,
            })
            .where('id = :id', { id: scheduleId })
            .andWhere('status = :status', { status: WorkScheduleStatus.ACTIVE })
            .andWhere('nextRunAt = :nextRunAt', {
                nextRunAt: originalNextRunAt.getTime(),
            })
            .execute();

        return (result.affected ?? 0) > 0 ? originalNextRunAt : null;
    }

    async countActiveByUser(userId: string): Promise<number> {
        return this.repository.count({
            where: { userId, status: WorkScheduleStatus.ACTIVE },
        });
    }
}
