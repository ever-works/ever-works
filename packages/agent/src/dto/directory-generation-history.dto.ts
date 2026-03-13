import { GenerationMethod } from '@src/items-generator/dto/create-items-generator.dto';
import { GenerateStatusType } from '@src/entities/types';
import { GenerationMetrics } from '@src/entities/directory-generation-history.entity';
import { DirectoryHistoryActivityType, type DirectoryChangelog } from '@ever-works/contracts/api';

export interface DirectoryGenerationHistoryDto {
    id: string;
    status: GenerateStatusType;
    generationMethod?: GenerationMethod | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    durationInSeconds?: number | null;
    newItemsCount: number;
    updatedItemsCount: number;
    totalItemsCount: number;
    metrics?: GenerationMetrics | null;
    errorMessage?: string | null;
    parameters?: Record<string, any> | null;
    createdAt: string;
    updatedAt: string;
    triggerRunId?: string;
    activityType: DirectoryHistoryActivityType;
    changelog?: DirectoryChangelog | null;
}

export interface DirectoryGenerationHistoryListDto {
    history: DirectoryGenerationHistoryDto[];
    total: number;
    limit: number;
    offset: number;
}
