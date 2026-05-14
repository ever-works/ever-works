import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { ActivityLog } from '../../entities/activity-log.entity';
import { buildCaseInsensitiveLikeClause, prepareCaseInsensitiveContainsPattern } from '../utils';
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

    async create(
        data: CreateActivityLogDto,
        overrides?: { createdAt?: Date },
    ): Promise<ActivityLog> {
        const entry = this.repository.create({
            ...data,
            ...(overrides?.createdAt ? { createdAt: overrides.createdAt } : {}),
        });
        return this.repository.save(entry);
    }

    async update(id: string, data: Partial<ActivityLog>): Promise<ActivityLog | null> {
        await this.repository.update(id, data);
        return this.findById(id);
    }

    async findById(id: string): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: { id },
            relations: ['work'],
        });
    }

    async findByIdAndUserId(id: string, userId: string): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: { id, userId },
            relations: ['work'],
        });
    }

    async findByWorkAndIngestEventId(
        workId: string,
        ingestEventId: string,
    ): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: { workId, ingestEventId },
        });
    }

    /**
     * Per-Work activity-log lookup that intentionally ignores `userId`.
     *
     * The Activity Feed tab is scoped by `workId` and access is enforced
     * upstream by `WorkOwnershipService.ensureAccess` (controller layer).
     * Filtering by `userId` here would drop rows attributed to other
     * collaborators on the same Work — including the website-ingested
     * rows that EW-120 attributes to the Work owner — making them
     * invisible to members.
     */
    async findByWork(options: {
        workId: string;
        /**
         * Filter by a single action type or a set of types (issues a single
         * `IN (...)` query instead of N parallel queries). Accepting an
         * array lets the feed aggregator avoid the per-type fan-out that
         * previously multiplied the row budget.
         */
        actionType?: ActivityActionType | ActivityActionType[];
        dateTo?: Date;
        limit?: number;
        offset?: number;
    }): Promise<{ activities: ActivityLog[]; total: number }> {
        const qb = this.repository
            .createQueryBuilder('activity')
            .leftJoinAndSelect('activity.work', 'work')
            .where('activity.workId = :workId', { workId: options.workId })
            .orderBy('activity.createdAt', 'DESC');

        if (options.actionType) {
            if (Array.isArray(options.actionType)) {
                if (options.actionType.length > 0) {
                    qb.andWhere('activity.actionType IN (:...actionTypes)', {
                        actionTypes: options.actionType,
                    });
                }
            } else {
                qb.andWhere('activity.actionType = :actionType', {
                    actionType: options.actionType,
                });
            }
        }
        if (options.dateTo) {
            qb.andWhere('activity.createdAt <= :dateTo', { dateTo: options.dateTo });
        }

        const limit = Math.min(options.limit ?? 25, 100);
        const offset = options.offset ?? 0;

        const [activities, total] = await qb.take(limit).skip(offset).getManyAndCount();
        return { activities, total };
    }

    async findLatestByUserWorkActionStatus(params: {
        userId: string;
        workId: string;
        actionType: ActivityActionType;
        status: ActivityStatus;
    }): Promise<ActivityLog | null> {
        return this.repository.findOne({
            where: {
                userId: params.userId,
                workId: params.workId,
                actionType: params.actionType,
                status: params.status,
            },
            order: { createdAt: 'DESC' },
            relations: ['work'],
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
            .leftJoinAndSelect('activity.work', 'work')
            .where('activity.userId = :userId', { userId: options.userId })
            .orderBy('activity.createdAt', 'DESC');

        if (options.actionType) {
            qb.andWhere('activity.actionType = :actionType', { actionType: options.actionType });
        }

        if (options.workId) {
            qb.andWhere('activity.workId = :workId', {
                workId: options.workId,
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
            const searchPattern = prepareCaseInsensitiveContainsPattern(options.search);
            if (searchPattern) {
                qb.andWhere(
                    new Brackets((searchQb) => {
                        searchQb
                            .where(buildCaseInsensitiveLikeClause('activity.summary'), {
                                search: searchPattern,
                            })
                            .orWhere(buildCaseInsensitiveLikeClause('work.name'), {
                                search: searchPattern,
                            });
                    }),
                );
            }
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
            cancelled: 0,
        } as Record<ActivityStatus, number>;

        for (const row of rows) {
            counts[row.status] = Number(row.count) || 0;
        }

        return counts;
    }
}
