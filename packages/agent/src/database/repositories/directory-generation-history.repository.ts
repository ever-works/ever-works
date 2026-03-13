import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DirectoryGenerationHistory, GenerationMetrics } from '@src/entities';
import { GenerateStatusType } from '@src/entities/types';
import { DirectoryHistoryActivityType, type DirectoryChangelog, type GenerationStepLog } from '@ever-works/contracts/api';

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

    async appendLogs(id: string, newLogs: GenerationStepLog[]): Promise<void> {
        if (!newLogs.length) return;

        const entry = await this.repository.findOne({ where: { id } });
        if (!entry) return;

        const existing = entry.logs ?? [];
        await this.repository.update(id, { logs: [...existing, ...newLogs] });
    }

    async deleteEntry(id: string): Promise<void> {
        await this.repository.delete(id);
    }

    async deleteByDirectory(directoryId: string): Promise<void> {
        await this.repository.delete({ directoryId });
    }
}
