import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DirectoryGenerationHistory, GenerationMetrics } from '@src/entities';
import { GenerateStatusType } from '@src/entities/types';
import {
    DirectoryHistoryActivityType,
    type DirectoryChangelog,
    type GenerationStepLog,
} from '@ever-works/contracts/api';

type HistoryCreateParams = {
    directoryId: string;
    userId?: string | null;
    generationMethod?: string | null;
    parameters?: Record<string, any> | null;
    status?: GenerateStatusType;
    startedAt?: Date;
    triggeredBy?: 'user' | 'schedule' | 'api';
    scheduleId?: string | null;
    activityType?: DirectoryHistoryActivityType;
    changelog?: DirectoryChangelog | null;
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
    activityType?: DirectoryHistoryActivityType;
    changelog?: DirectoryChangelog | null;
    logs?: GenerationStepLog[] | null;
};

@Injectable()
export class DirectoryGenerationHistoryRepository {
    constructor(
        @InjectRepository(DirectoryGenerationHistory)
        private readonly repository: Repository<DirectoryGenerationHistory>,
    ) {}

    async createEntry(params: HistoryCreateParams): Promise<DirectoryGenerationHistory> {
        const record = this.repository.create({
            directoryId: params.directoryId,
            userId: params.userId ?? null,
            generationMethod: params.generationMethod as any,
            parameters: params.parameters ?? null,
            status: params.status ?? GenerateStatusType.GENERATING,
            startedAt: params.startedAt,
            triggeredBy: params.triggeredBy ?? 'user',
            scheduleId: params.scheduleId ?? null,
            activityType: params.activityType ?? DirectoryHistoryActivityType.GENERATION,
            changelog: params.changelog ?? null,
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
    ): Promise<DirectoryGenerationHistory | null> {
        await this.repository.update(id, {
            ...updates,
        });

        return this.repository.findOne({ where: { id } });
    }

    async findByDirectory(directoryId: string, limit = 20, offset = 0) {
        return this.repository.find({
            where: { directoryId },
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: limit,
            skip: offset,
        });
    }

    async findByDirectoryFiltered(
        directoryId: string,
        limit = 20,
        offset = 0,
        activityTypes?: DirectoryHistoryActivityType[],
    ) {
        return this.repository.find({
            where: {
                directoryId,
                ...(activityTypes?.length ? { activityType: In(activityTypes) } : {}),
            },
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: limit,
            skip: offset,
        });
    }

    async countByDirectory(
        directoryId: string,
        activityTypes?: DirectoryHistoryActivityType[],
    ): Promise<number> {
        return this.repository.count({
            where: {
                directoryId,
                ...(activityTypes?.length ? { activityType: In(activityTypes) } : {}),
            },
        });
    }

    async findById(id: string): Promise<DirectoryGenerationHistory | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findLatestInProgressByDirectory(
        directoryId: string,
    ): Promise<DirectoryGenerationHistory | null> {
        return this.repository.findOne({
            where: {
                directoryId,
                status: GenerateStatusType.GENERATING,
            },
            order: { startedAt: 'DESC', createdAt: 'DESC' },
        });
    }

    async findLatestPositiveItemCounts(directoryIds: string[]): Promise<Map<string, number>> {
        const uniqueDirectoryIds = Array.from(new Set(directoryIds));
        if (uniqueDirectoryIds.length === 0) {
            return new Map();
        }

        const rows = await this.repository
            .createQueryBuilder('history')
            .select('history.directoryId', 'directoryId')
            .addSelect('history.totalItemsCount', 'totalItemsCount')
            .where('history.directoryId IN (:...directoryIds)', {
                directoryIds: uniqueDirectoryIds,
            })
            .andWhere('history.totalItemsCount > 0')
            .andWhere((queryBuilder) => {
                const subQuery = queryBuilder
                    .subQuery()
                    .select('1')
                    .from(DirectoryGenerationHistory, 'newer')
                    .where('newer.directoryId = history.directoryId')
                    .andWhere('newer.totalItemsCount > 0')
                    .andWhere(
                        `(
                            newer.startedAt > history.startedAt
                            OR (
                                newer.startedAt = history.startedAt
                                AND newer.createdAt > history.createdAt
                            )
                        )`,
                    )
                    .getQuery();

                return `NOT EXISTS ${subQuery}`;
            })
            .getRawMany<{ directoryId: string; totalItemsCount: string | number }>();

        const counts = new Map<string, number>();
        for (const row of rows) {
            const current = counts.get(row.directoryId);
            const totalItemsCount = Number(row.totalItemsCount);

            // If multiple rows tie on timestamps, keep the largest positive count deterministically.
            if (current === undefined || totalItemsCount > current) {
                counts.set(row.directoryId, totalItemsCount);
            }
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
     * Find history records stuck in GENERATING whose directory is no longer generating.
     * These are orphaned records where the generation finished (or errored) at the directory
     * level but the history record was never updated — e.g. due to a crash or missed finally block.
     *
     * Safety: this query relies on recordGenerationStartTime always resetting
     * generationFinishedAt to null. If that invariant changes, add a condition on
     * d.generateStatus to exclude currently active generations.
     */
    async findOrphanedGenerating(): Promise<DirectoryGenerationHistory[]> {
        return this.repository
            .createQueryBuilder('h')
            .innerJoin('h.directory', 'd')
            .where('h.status = :historyStatus', { historyStatus: GenerateStatusType.GENERATING })
            .andWhere('d.generationFinishedAt IS NOT NULL')
            .getMany();
    }

    async deleteEntry(id: string): Promise<void> {
        await this.repository.delete(id);
    }

    async deleteByDirectory(directoryId: string): Promise<void> {
        await this.repository.delete({ directoryId });
    }
}
