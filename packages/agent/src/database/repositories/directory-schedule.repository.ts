import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { DirectorySchedule } from '@src/entities/directory-schedule.entity';
import { DirectoryScheduleStatus, GenerateStatusType } from '@src/entities/types';

@Injectable()
export class DirectoryScheduleRepository {
    constructor(
        @InjectRepository(DirectorySchedule)
        private readonly repository: Repository<DirectorySchedule>,
    ) {}

    async findByDirectoryId(directoryId: string): Promise<DirectorySchedule | null> {
        return this.repository.findOne({
            where: { directoryId },
            relations: ['directory', 'user'],
        });
    }

    async upsert(
        directoryId: string,
        data: Partial<DirectorySchedule>,
    ): Promise<DirectorySchedule> {
        await this.repository.upsert(
            {
                directoryId,
                ...data,
            },
            ['directoryId'],
        );

        return this.findByDirectoryId(directoryId);
    }

    async findById(id: string): Promise<DirectorySchedule | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['directory', 'user'],
        });
    }

    async updateById(id: string, data: Partial<DirectorySchedule>): Promise<void> {
        await this.repository.update(id, data);
    }

    async markRun(
        scheduleId: string,
        status: DirectoryScheduleStatus,
        lastRunStatus: GenerateStatusType,
        nextRunAt: Date | null,
    ) {
        const updateData: Partial<DirectorySchedule> = {
            status,
            lastRunStatus,
            lastRunAt: new Date(),
            nextRunAt,
        };

        if (status === DirectoryScheduleStatus.ACTIVE) {
            updateData.failureCount = 0;
        }

        await this.repository.update(scheduleId, updateData);
    }

    async incrementFailure(scheduleId: string): Promise<void> {
        await this.repository.increment({ id: scheduleId }, 'failureCount', 1);
    }

    async findDue(limit: number): Promise<DirectorySchedule[]> {
        return this.repository.find({
            where: {
                status: DirectoryScheduleStatus.ACTIVE,
                nextRunAt: LessThanOrEqual(new Date()),
            },
            order: { nextRunAt: 'ASC' },
            take: limit,
            relations: ['directory', 'user'],
        });
    }

    async findStuckGenerating(olderThan: Date): Promise<DirectorySchedule[]> {
        return this.repository.find({
            where: {
                lastRunStatus: GenerateStatusType.GENERATING,
                updatedAt: LessThanOrEqual(olderThan),
            },
        });
    }

    async pause(scheduleId: string): Promise<void> {
        await this.repository.update(scheduleId, { status: DirectoryScheduleStatus.PAUSED });
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
            .update(DirectorySchedule)
            .set({
                lastRunStatus: GenerateStatusType.GENERATING,
                scheduledFor: originalNextRunAt,
                nextRunAt: null,
                lastRunAt: dispatchedAt,
                updatedAt: dispatchedAt,
            })
            .where('id = :id', { id: scheduleId })
            .andWhere('status = :status', { status: DirectoryScheduleStatus.ACTIVE })
            .andWhere('nextRunAt = :nextRunAt', { nextRunAt: originalNextRunAt })
            .execute();

        return (result.affected ?? 0) > 0 ? originalNextRunAt : null;
    }

    async countActiveByUser(userId: string): Promise<number> {
        return this.repository.count({
            where: { userId, status: DirectoryScheduleStatus.ACTIVE },
        });
    }
}
