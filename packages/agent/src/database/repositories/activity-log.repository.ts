import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActivityLog } from '../../entities/activity-log.entity';
import type {
    ActivityLogQueryOptions,
    ActivityStatus,
    CreateActivityLogDto,
} from '../../entities/activity-log.types';

@Injectable()
export class ActivityLogRepository {
    constructor(
        @InjectRepository(ActivityLog)
        private readonly repository: Repository<ActivityLog>,
    ) {}

    async create(data: CreateActivityLogDto): Promise<ActivityLog> {
        const entry = this.repository.create(data);
        return this.repository.save(entry);
    }

    async update(id: string, data: Partial<ActivityLog>): Promise<ActivityLog | null> {
        await this.repository.update(id, data);
        return this.findById(id);
    }

    async findById(id: string): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['directory'],
        });
    }

    async findByIdAndUserId(id: string, userId: string): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: { id, userId },
            relations: ['directory'],
        });
    }

    async findByUserId(
        options: ActivityLogQueryOptions,
    ): Promise<{ activities: ActivityLog[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('activity')
            .leftJoinAndSelect('activity.directory', 'directory')
            .where('activity.userId = :userId', { userId: options.userId })
            .orderBy('activity.createdAt', 'DESC');

        if (options.actionType) {
            qb.andWhere('activity.actionType = :actionType', { actionType: options.actionType });
        }

        if (options.directoryId) {
            qb.andWhere('activity.directoryId = :directoryId', {
                directoryId: options.directoryId,
            });
        }

        if (options.status) {
            qb.andWhere('activity.status = :status', { status: options.status });
        }

        if (options.dateFrom) {
            qb.andWhere('activity.createdAt >= :dateFrom', { dateFrom: options.dateFrom });
        }

        if (options.dateTo) {
            qb.andWhere('activity.createdAt <= :dateTo', { dateTo: options.dateTo });
        }

        if (options.search) {
            qb.andWhere('(activity.summary LIKE :search OR directory.name LIKE :search)', {
                search: `%${options.search}%`,
            });
        }

        const limit = Math.min(options.limit || 25, 100);
        const offset = options.offset || 0;

        const [activities, total] = await qb.take(limit).skip(offset).getManyAndCount();

        return { activities, total };
    }

    async countByStatus(userId: string, status: ActivityStatus): Promise<number> {
        return this.repository.count({
            where: { userId, status },
        });
    }

    async deleteById(id: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }
}
