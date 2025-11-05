import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DirectoryGenerationHistory, GenerationMetrics } from '@src/entities';
import { GenerateStatusType } from '@src/entities/types';

type HistoryCreateParams = {
    directoryId: string;
    userId?: string | null;
    generationMethod?: string | null;
    parameters?: Record<string, any> | null;
    status?: GenerateStatusType;
    startedAt?: Date;
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

    async countByDirectory(directoryId: string): Promise<number> {
        return this.repository.count({ where: { directoryId } });
    }

    async findById(id: string): Promise<DirectoryGenerationHistory | null> {
        return this.repository.findOne({ where: { id } });
    }
}
