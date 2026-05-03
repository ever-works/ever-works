import { GenerationMethod } from '@src/items-generator/dto/create-items-generator.dto';
import { GenerateStatusType } from '@src/entities/types';
import { GenerationMetrics } from '@src/entities/work-generation-history.entity';
import {
    WorkHistoryActivityType,
    type WorkChangelog,
    type GenerationStepLog,
} from '@ever-works/contracts/api';

export interface WorkGenerationHistoryDto {
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
    activityType: WorkHistoryActivityType;
    changelog?: WorkChangelog | null;
    logs?: GenerationStepLog[] | null;
    warnings?: string[] | null;
    triggeredBy?: 'user' | 'schedule' | 'api' | null;
}

export interface WorkGenerationHistoryListDto {
    history: WorkGenerationHistoryDto[];
    total: number;
    limit: number;
    offset: number;
}
