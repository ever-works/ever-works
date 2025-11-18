import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import {
    DirectorySchedule,
    DirectoryScheduleStatus,
} from '@src/entities/directory-schedule.entity';
import { GenerateStatusType } from '@src/entities/types';

@Injectable()
export class DirectoryScheduleRepository {
    constructor(
        @InjectRepository(DirectorySchedule)
        private readonly repository: Repository<DirectorySchedule>,
    ) {}

    async findByDirectoryId(directoryId: string): Promise<DirectorySchedule | null> {
        return this.repository.findOne({
            where: { directoryId },
            relations: ['directory', 'initiatedBySubscription', 'initiatedBySubscription.plan'],
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
            relations: ['directory', 'initiatedBySubscription'],
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
            relations: ['directory', 'user', 'user.oauthTokens'],
        });
    }

    async pause(scheduleId: string): Promise<void> {
        await this.repository.update(scheduleId, { status: DirectoryScheduleStatus.PAUSED });
    }
}
