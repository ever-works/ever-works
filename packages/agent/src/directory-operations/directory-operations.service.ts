import { Injectable, Optional } from '@nestjs/common';
import { DirectoryGenerationHistoryRepository, DirectoryRepository } from '@src/database';
import { Directory } from '@src/entities/directory.entity';
import { GenerationMetrics } from '@src/entities/directory-generation-history.entity';
import { GenerateStatusType } from '@src/entities/types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DirectoryGenerationCompletedEvent } from '@src/events';
import { GenerationStats } from '../generators/data-generator/data-generator.service';
import { DirectoryImportResult } from '../tasks/directory-import.types';
import type { DirectoryChangelog } from '@ever-works/contracts/api';

export type GenerationHistoryUpdateInput = {
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
    changelog?: DirectoryChangelog | null;
};

export function buildStatsUpdate(
    stats: GenerationStats | null | undefined,
): Pick<
    GenerationHistoryUpdateInput,
    'newItemsCount' | 'updatedItemsCount' | 'totalItemsCount' | 'metrics' | 'changelog'
> {
    return {
        newItemsCount: stats?.newItemsCount ?? 0,
        updatedItemsCount: stats?.updatedItemsCount ?? 0,
        totalItemsCount: stats?.totalItemsCount ?? 0,
        metrics: stats?.metrics,
        changelog: stats?.changelog ?? null,
    };
}

export function buildImportStatsUpdate(
    result: DirectoryImportResult | null | undefined,
): Pick<
    GenerationHistoryUpdateInput,
    'newItemsCount' | 'updatedItemsCount' | 'totalItemsCount' | 'metrics'
> {
    const itemsImported = result?.itemsImported ?? 0;
    return {
        newItemsCount: result?.stats?.newItemsCount ?? itemsImported,
        updatedItemsCount: result?.stats?.updatedItemsCount ?? 0,
        totalItemsCount: result?.stats?.totalItemsCount ?? itemsImported,
        metrics: result?.metrics
            ? {
                  total_tokens_used: result.metrics.total_tokens_used ?? 0,
                  total_cost: result.metrics.total_cost ?? 0,
                  new_items_added_to_store: result?.stats?.newItemsCount ?? itemsImported,
                  total_items_in_store: result?.stats?.totalItemsCount ?? itemsImported,
              }
            : undefined,
    };
}

@Injectable()
export class DirectoryOperationsService {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        @Optional() private readonly eventEmitter?: EventEmitter2,
    ) {}

    async updateDirectory(id: string, updateData: Partial<Directory>): Promise<void> {
        await this.directoryRepository.update(id, updateData);
    }

    async getGenerateStatus(id: string): Promise<Directory['generateStatus'] | undefined> {
        const directory = await this.directoryRepository.findById(id);
        return directory?.generateStatus;
    }

    async updateGenerateStatus(id: string, status: Directory['generateStatus']): Promise<void> {
        if (status?.warnings?.length) {
            status = { ...status, warnings: [...new Set(status.warnings)] };
        }
        await this.directoryRepository.updateGenerateStatus(id, status);
    }

    async updateLastPullRequest(id: string, payload: Directory['lastPullRequest']): Promise<void> {
        await this.directoryRepository.updateLastPullRequest(id, payload);
    }

    async recordGenerationStartTime(id: string, startedAt: Date): Promise<void> {
        await this.directoryRepository.recordGenerationStartTime(id, startedAt);
    }

    async recordGenerationFinishTime(id: string, finishedAt: Date): Promise<void> {
        await this.directoryRepository.recordGenerationFinishTime(id, finishedAt);
    }

    async emitGenerationCompleted(directoryId: string): Promise<void> {
        if (!this.eventEmitter) {
            return;
        }

        const directory = await this.directoryRepository.findById(directoryId);
        if (!directory) {
            return;
        }

        this.eventEmitter.emit(
            DirectoryGenerationCompletedEvent.EVENT_NAME,
            new DirectoryGenerationCompletedEvent(directory),
        );
    }

    async updateGenerationHistory(
        _directoryId: string,
        historyId: string,
        updates: GenerationHistoryUpdateInput,
    ): Promise<void> {
        await this.generationHistoryRepository.updateEntry(historyId, updates);
    }
}
