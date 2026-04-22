import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActivityLog } from '../../entities/activity-log.entity';
import type {
    ActivityLogQueryOptions,
    ActivityActionType,
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

    async findLatestByUserDirectoryActionStatus(params: {
        userId: string;
        directoryId: string;
        actionType: ActivityActionType;
        status: ActivityStatus;
    }): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: {
                userId: params.userId,
                directoryId: params.directoryId,
                actionType: params.actionType,
                status: params.status,
            },
            order: { createdAt: 'DESC' },
            relations: ['directory'],
        });
    }

    async findInProgressGenerationsByUserId(userId: string): Promise<ActivityLog[]> {
        return this.repository.find({
            where: {
                userId,
                actionType: 'generation' as ActivityActionType,
                status: 'in_progress' as ActivityStatus,
            },
            order: { createdAt: 'DESC' },
        });
    }

    async findByUserId(
        options: ActivityLogQueryOptions,
    ): Promise<{ activities: ActivityLog[]; total: number }> {
        return this.findByUserIdWithLimit(options, true);
    }

    async findByUserIdForExport(options: ActivityLogQueryOptions): Promise<ActivityLog[]> {
        const { activities } = await this.findByUserIdWithLimit(options, false);
        return activities;
    }

    private async findByUserIdWithLimit(
        options: ActivityLogQueryOptions,
        enforceCap: boolean,
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

        const requestedLimit = options.limit || 25;
        const limit = enforceCap ? Math.min(requestedLimit, 100) : requestedLimit;
        const offset = options.offset || 0;

        const [activities, total] = await qb.take(limit).skip(offset).getManyAndCount();

        return { activities, total };
    }

    async countByStatus(userId: string, status: ActivityStatus): Promise<number> {
        return this.repository.count({
            where: { userId, status },
        });
    }

    async countByStatuses(userId: string): Promise<Record<ActivityStatus, number>> {
        const rows = await this.repository
            .createQueryBuilder('activity')
            .select('activity.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .where('activity.userId = :userId', { userId })
            .groupBy('activity.status')
            .getRawMany<{ status: ActivityStatus; count: string }>();

        let counts = {
            pending: 0,
            in_progress: 0,
            completed: 0,
            failed: 0,
        } as Record<ActivityStatus, number>;

        for (const row of rows) {
            counts[row.status] = Number(row.count) || 0;
        }

        return counts;
    }
}
