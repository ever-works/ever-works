import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
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

const LATEST_POSITIVE_ITEM_COUNTS_BATCH_MULTIPLIER = 10;

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

        const counts = new Map<string, number>();
        const batchSize = Math.max(
            uniqueDirectoryIds.length * LATEST_POSITIVE_ITEM_COUNTS_BATCH_MULTIPLIER,
            uniqueDirectoryIds.length,
        );
        let skip = 0;

        while (counts.size < uniqueDirectoryIds.length) {
            const records = await this.repository.find({
                where: {
                    directoryId: In(uniqueDirectoryIds),
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
                if (!counts.has(record.directoryId)) {
                    counts.set(record.directoryId, record.totalItemsCount);
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
