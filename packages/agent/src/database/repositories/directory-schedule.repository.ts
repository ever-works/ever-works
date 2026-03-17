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
        let schedule = await this.repository.findOne({ where: { directoryId } });

        if (schedule) {
            await this.repository.update(schedule.id, data);
            return this.repository.findOne({
                where: { id: schedule.id },
                relations: ['directory', 'user'],
            });
        }

        schedule = this.repository.create({ directoryId, ...data });
        await this.repository.save(schedule);
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
                lastRunAt: LessThanOrEqual(olderThan),
            },
        });
    }

    async pause(scheduleId: string): Promise<void> {
        await this.repository.update(scheduleId, { status: DirectoryScheduleStatus.PAUSED });
    }

    async tryMarkDispatched(scheduleId: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(DirectorySchedule)
            .set({
                lastRunStatus: GenerateStatusType.GENERATING,
                nextRunAt: null,
                updatedAt: () => 'CURRENT_TIMESTAMP',
            })
            .where('id = :id', { id: scheduleId })
            .andWhere('status = :status', { status: DirectoryScheduleStatus.ACTIVE })
            .andWhere('nextRunAt IS NOT NULL')
            .execute();

        return (result.affected ?? 0) > 0;
    }

    async countActiveByUser(userId: string): Promise<number> {
        return this.repository.count({
            where: { userId, status: DirectoryScheduleStatus.ACTIVE },
        });
    }
}
