import { ImportSourceType } from '@src/entities/work.entity';
import type { ImportEnrichmentConfigDto } from '@src/dto/import-work.dto';
import type { ProvidersDto } from '@ever-works/contracts/api';
import type { ResolvedWorksConfig } from '@src/works-config/services/works-config.service';

export type WorkImportPayload = {
    workId: string;
    userId: string;
    sourceUrl: string;
    sourceOwner: string;
    sourceRepo: string;
    sourceType: ImportSourceType;
    historyId: string;
    historyStartedAt?: string;
    triggerSource?: 'user' | 'schedule' | 'api';
    options?: {
        createMissingRepos?: boolean;
        enableSync?: boolean;
    };
    providers?: ProvidersDto;
    enrichmentConfig?: ImportEnrichmentConfigDto;
    worksConfig?: ResolvedWorksConfig | null;
};

export type WorkImportMetrics = {
    total_tokens_used?: number;
    total_cost?: number;
};

export type WorkImportStats = {
    newItemsCount: number;
    updatedItemsCount: number;
    totalItemsCount: number;
};

export type WorkImportResult = {
    success: boolean;
    workId: string;
    itemsImported?: number;
    categoriesImported?: number;
    tagsImported?: number;
    metrics?: WorkImportMetrics;
    stats?: WorkImportStats;
    error?: string;
    errorCode?: WorkImportErrorCode;
};

export enum WorkImportErrorCode {
    INVALID_URL = 'INVALID_URL',
    REPO_NOT_FOUND = 'REPO_NOT_FOUND',
    REPO_ACCESS_DENIED = 'REPO_ACCESS_DENIED',
    UNSUPPORTED_FORMAT = 'UNSUPPORTED_FORMAT',
    PARSE_FAILED = 'PARSE_FAILED',
    CLONE_FAILED = 'CLONE_FAILED',
    CREATE_REPO_FAILED = 'CREATE_REPO_FAILED',
    GENERATION_FAILED = 'GENERATION_FAILED',
    ENRICHMENT_FAILED = 'ENRICHMENT_FAILED',
    UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}
