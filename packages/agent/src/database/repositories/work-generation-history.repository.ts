import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, MoreThan, Repository } from 'typeorm';
import { WorkGenerationHistory, GenerationMetrics } from '@src/entities';
import { GenerateStatusType } from '@src/entities/types';
import {
    WorkHistoryActivityType,
    type WorkChangelog,
    type GenerationStepLog,
} from '@ever-works/contracts/api';

type HistoryCreateParams = {
    workId: string;
    userId?: string | null;
    generationMethod?: string | null;
    parameters?: Record<string, any> | null;
    status?: GenerateStatusType;
    startedAt?: Date;
    triggeredBy?: 'user' | 'schedule' | 'api';
    scheduleId?: string | null;
    activityType?: WorkHistoryActivityType;
    changelog?: WorkChangelog | null;
    warnings?: string[] | null;
    finishedAt?: Date | null;
    durationInSeconds?: number | null;
    newItemsCount?: number;
    updatedItemsCount?: number;
    totalItemsCount?: number;
};

type HistoryUpdateParams = {
    status?: GenerateStatusType;
    newItemsCount?: number;
    updatedItemsCount?: number;
    totalItemsCount?: number;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    durationInSeconds?: number | null;
    errorMessage?: string | null;
    metrics?: GenerationMetrics | null;
    parameters?: Record<string, any> | null;
    triggerRunId?: string;
    activityType?: WorkHistoryActivityType;
    changelog?: WorkChangelog | null;
    logs?: GenerationStepLog[] | null;
    warnings?: string[] | null;
};

const LATEST_POSITIVE_ITEM_COUNTS_BATCH_MULTIPLIER = 10;

function normalizeWarnings(warnings?: string[] | null): string[] | null {
    return warnings?.length ? [...new Set(warnings)] : null;
}

@Injectable()
export class WorkGenerationHistoryRepository {
    constructor(
        @InjectRepository(WorkGenerationHistory)
        private readonly repository: Repository<WorkGenerationHistory>,
    ) {}

    async createEntry(params: HistoryCreateParams): Promise<WorkGenerationHistory> {
        const record = this.repository.create({
            workId: params.workId,
            userId: params.userId ?? null,
            generationMethod: params.generationMethod as any,
            parameters: params.parameters ?? null,
            status: params.status ?? GenerateStatusType.GENERATING,
            startedAt: params.startedAt,
            triggeredBy: params.triggeredBy ?? 'user',
            scheduleId: params.scheduleId ?? null,
            activityType: params.activityType ?? WorkHistoryActivityType.GENERATION,
            changelog: params.changelog ?? null,
            warnings: normalizeWarnings(params.warnings),
            finishedAt: params.finishedAt ?? null,
            durationInSeconds: params.durationInSeconds ?? null,
            newItemsCount: params.newItemsCount ?? 0,
            updatedItemsCount: params.updatedItemsCount ?? 0,
            totalItemsCount: params.totalItemsCount ?? 0,
        });

        return this.repository.save(record);
    }

    async updateEntry(
        id: string,
        updates: HistoryUpdateParams,
    ): Promise<WorkGenerationHistory | null> {
        const normalizedUpdates = {
            ...updates,
            ...('warnings' in updates
                ? {
                      warnings: normalizeWarnings(updates.warnings),
                  }
                : {}),
        };

        await this.repository.update(id, {
            ...normalizedUpdates,
        });

        return this.repository.findOne({ where: { id } });
    }

    async findByWork(workId: string, limit = 20, offset = 0) {
        return this.repository.find({
            where: { workId },
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: limit,
            skip: offset,
        });
    }

    async findByWorkFiltered(
        workId: string,
        limit = 20,
        offset = 0,
        activityTypes?: WorkHistoryActivityType[],
        before?: Date,
    ) {
        // No-cursor path keeps the simple TypeORM find() so we don't
        // regress query plans for existing callers.
        if (!before) {
            return this.repository.find({
                where: {
                    workId,
                    ...(activityTypes?.length ? { activityType: In(activityTypes) } : {}),
                },
                order: { startedAt: 'DESC', createdAt: 'DESC' },
                take: limit,
                skip: offset,
            });
        }

        // Cursor path — the predicate must run in SQL, not in memory.
        // Otherwise, when every row in the top-N batch is newer than the
        // cursor (the common steady-state pagination case), the filter
        // returns 0 entries and the next-cursor advance silently skips
        // the older rows beyond the limit.
        //
        // Ordering is `startedAt DESC, createdAt DESC`, so the effective
        // "row timestamp" is `COALESCE(startedAt, createdAt)`. Direct
        // COALESCE won't work here because the two columns are bigint
        // vs. timestamptz — express the same semantics as an OR over the
        // two columns instead.
        const beforeMs = before.getTime();
        const qb = this.repository
            .createQueryBuilder('h')
            .where('h.workId = :workId', { workId })
            .orderBy('h.startedAt', 'DESC')
            .addOrderBy('h.createdAt', 'DESC')
            .take(limit)
            .skip(offset);
        if (activityTypes?.length) {
            qb.andWhere('h.activityType IN (:...activityTypes)', { activityTypes });
        }
        qb.andWhere(
            new Brackets((b) => {
                b.where('h.startedAt IS NOT NULL AND h.startedAt < :beforeMs', { beforeMs })
                    .orWhere(
                        'h.startedAt IS NULL AND h.createdAt < :beforeDate',
                        { beforeDate: before },
                    );
            }),
        );
        return qb.getMany();
    }

    async countByWork(workId: string, activityTypes?: WorkHistoryActivityType[]): Promise<number> {
        return this.repository.count({
            where: {
                workId,
                ...(activityTypes?.length ? { activityType: In(activityTypes) } : {}),
            },
        });
    }

    async findById(id: string): Promise<WorkGenerationHistory | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findLatestInProgressByWork(workId: string): Promise<WorkGenerationHistory | null> {
        return this.repository.findOne({
            where: {
                workId,
                status: GenerateStatusType.GENERATING,
            },
            order: { startedAt: 'DESC', createdAt: 'DESC' },
        });
    }

    async findLatestCompletedByWork(workId: string): Promise<WorkGenerationHistory | null> {
        return this.repository
            .createQueryBuilder('history')
            .where('history.workId = :workId', { workId })
            .andWhere('history.finishedAt IS NOT NULL')
            .orderBy('history.finishedAt', 'DESC')
            .addOrderBy('history.createdAt', 'DESC')
            .getOne();
    }

    async findLatestPositiveItemCounts(workIds: string[]): Promise<Map<string, number>> {
        const uniqueWorkIds = Array.from(new Set(workIds));
        if (uniqueWorkIds.length === 0) {
            return new Map();
        }

        const counts = new Map<string, number>();
        const batchSize = Math.max(
            uniqueWorkIds.length * LATEST_POSITIVE_ITEM_COUNTS_BATCH_MULTIPLIER,
            uniqueWorkIds.length,
        );
        let skip = 0;

        while (counts.size < uniqueWorkIds.length) {
            const records = await this.repository.find({
                where: {
                    workId: In(uniqueWorkIds),
                    totalItemsCount: MoreThan(0),
                },
                order: { startedAt: 'DESC', createdAt: 'DESC' },
                take: batchSize,
                skip,
            });

            if (records.length === 0) {
                break;
            }

            for (const record of records) {
                if (!counts.has(record.workId)) {
                    counts.set(record.workId, record.totalItemsCount);
                }
            }

            if (records.length < batchSize) {
                break;
            }

            skip += records.length;
        }

        return counts;
    }

    async appendLogs(id: string, newLogs: GenerationStepLog[]): Promise<void> {
        if (!newLogs.length) return;

        const entry = await this.repository.findOne({ where: { id } });
        if (!entry) return;

        const existing = entry.logs ?? [];
        await this.repository.update(id, { logs: [...existing, ...newLogs] });
    }

    /**
     * Find history records stuck in GENERATING whose work is no longer generating.
     * These are orphaned records where the generation finished (or errored) at the work
     * level but the history record was never updated — e.g. due to a crash or missed finally block.
     *
     * Safety: this query relies on recordGenerationStartTime always resetting
     * generationFinishedAt to null. If that invariant changes, add a condition on
     * d.generateStatus to exclude currently active generations.
     */
    async findOrphanedGenerating(): Promise<WorkGenerationHistory[]> {
        return this.repository
            .createQueryBuilder('h')
            .innerJoin('h.work', 'd')
            .where('h.status = :historyStatus', { historyStatus: GenerateStatusType.GENERATING })
            .andWhere('d.generationFinishedAt IS NOT NULL')
            .getMany();
    }

    async deleteEntry(id: string): Promise<void> {
        await this.repository.delete(id);
    }

    async deleteByWork(workId: string): Promise<void> {
        await this.repository.delete({ workId });
    }
}
