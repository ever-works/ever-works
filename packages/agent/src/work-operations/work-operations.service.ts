import { Injectable, Optional } from '@nestjs/common';
import { WorkGenerationHistoryRepository, WorkRepository } from '@src/database';
import { Work } from '@src/entities/work.entity';
import { GenerationMetrics } from '@src/entities/work-generation-history.entity';
import { GenerateStatusType } from '@src/entities/types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkGenerationCompletedEvent } from '@src/events';
import { GenerationStats } from '../generators/data-generator/data-generator.service';
import { WorkImportResult } from '../tasks/work-import.types';
import type { WorkChangelog, GenerationStepLog } from '@ever-works/contracts/api';

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
    changelog?: WorkChangelog | null;
    logs?: GenerationStepLog[] | null;
    warnings?: string[] | null;
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
    result: WorkImportResult | null | undefined,
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
export class WorkOperationsService {
    private readonly generateStatusUpdateQueue = new Map<string, Promise<void>>();

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
        @Optional() private readonly eventEmitter?: EventEmitter2,
    ) {}

    async updateWork(id: string, updateData: Partial<Work>): Promise<void> {
        await this.workRepository.update(id, updateData);
    }

    async getGenerateStatus(id: string): Promise<Work['generateStatus'] | undefined> {
        const work = await this.workRepository.findById(id);
        return work?.generateStatus;
    }

    async updateGenerateStatus(id: string, status: Work['generateStatus']): Promise<void> {
        await this.runGenerateStatusUpdate(id, async () => {
            await this.workRepository.updateGenerateStatus(
                id,
                this.normalizeGenerateStatus(status),
            );
        });
    }

    async updateGenerateRecentLogs(id: string, recentLogs: GenerationStepLog[]): Promise<void> {
        await this.runGenerateStatusUpdate(id, async () => {
            const currentStatus = await this.getGenerateStatus(id);
            if (!currentStatus) {
                return;
            }

            await this.workRepository.updateGenerateStatus(
                id,
                this.normalizeGenerateStatus({
                    ...currentStatus,
                    recentLogs,
                }),
            );
        });
    }

    async updateLastPullRequest(id: string, payload: Work['lastPullRequest']): Promise<void> {
        await this.workRepository.updateLastPullRequest(id, payload);
    }

    async recordGenerationStartTime(id: string, startedAt: Date): Promise<void> {
        await this.workRepository.recordGenerationStartTime(id, startedAt);
    }

    async recordGenerationFinishTime(id: string, finishedAt: Date): Promise<void> {
        await this.workRepository.recordGenerationFinishTime(id, finishedAt);
    }

    async emitGenerationCompleted(workId: string): Promise<void> {
        if (!this.eventEmitter) {
            return;
        }

        const work = await this.workRepository.findById(workId);
        if (!work) {
            return;
        }

        this.eventEmitter.emit(
            WorkGenerationCompletedEvent.EVENT_NAME,
            new WorkGenerationCompletedEvent(work),
        );
    }

    async appendGenerationLogs(historyId: string, logs: GenerationStepLog[]): Promise<void> {
        await this.generationHistoryRepository.appendLogs(historyId, logs);
    }

    async updateGenerationHistory(
        _workId: string,
        historyId: string,
        updates: GenerationHistoryUpdateInput,
    ): Promise<void> {
        await this.generationHistoryRepository.updateEntry(historyId, updates);
    }

    private normalizeGenerateStatus(
        status: Work['generateStatus'],
    ): Work['generateStatus'] {
        if (!status?.warnings?.length) {
            return status;
        }

        return {
            ...status,
            warnings: [...new Set(status.warnings)],
        };
    }

    private async runGenerateStatusUpdate(
        id: string,
        operation: () => Promise<void>,
    ): Promise<void> {
        const previous = this.generateStatusUpdateQueue.get(id) ?? Promise.resolve();
        const queued = previous.catch(() => undefined).then(operation);

        this.generateStatusUpdateQueue.set(id, queued);

        try {
            await queued;
        } finally {
            if (this.generateStatusUpdateQueue.get(id) === queued) {
                this.generateStatusUpdateQueue.delete(id);
            }
        }
    }
}
