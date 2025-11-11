import { Directory } from '@src/entities/directory.entity';
import { GenerationMetrics } from '@src/entities/directory-generation-history.entity';
import { GenerateStatusType } from '@src/entities/types';

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
};

export interface DirectoryOperations {
    updateDirectory(id: string, updateData: Partial<Directory>): Promise<void>;
    updateGenerateStatus(id: string, status: Directory['generateStatus']): Promise<void>;
    updateLastPullRequest(id: string, payload: Directory['lastPullRequest']): Promise<void>;
    recordGenerationStartTime(id: string, startedAt: Date): Promise<void>;
    recordGenerationFinishTime(id: string, finishedAt: Date): Promise<void>;
    emitGenerationCompleted(directory: Directory): Promise<void>;
    updateGenerationHistory(
        directoryId: string,
        historyId: string,
        updates: GenerationHistoryUpdateInput,
    ): Promise<void>;
}

export const DIRECTORY_OPERATIONS = Symbol('DIRECTORY_OPERATIONS');
