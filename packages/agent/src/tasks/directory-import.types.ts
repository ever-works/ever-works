import { ImportSourceType } from '@src/entities/directory.entity';

export type DirectoryImportPayload = {
    directoryId: string;
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
};

export type DirectoryImportMetrics = {
    total_tokens_used?: number;
    total_cost?: number;
};

export type DirectoryImportStats = {
    newItemsCount: number;
    updatedItemsCount: number;
    totalItemsCount: number;
};

export type DirectoryImportResult = {
    success: boolean;
    directoryId: string;
    itemsImported?: number;
    categoriesImported?: number;
    tagsImported?: number;
    metrics?: DirectoryImportMetrics;
    stats?: DirectoryImportStats;
    error?: string;
    errorCode?: DirectoryImportErrorCode;
};

export enum DirectoryImportErrorCode {
    INVALID_URL = 'INVALID_URL',
    REPO_NOT_FOUND = 'REPO_NOT_FOUND',
    REPO_ACCESS_DENIED = 'REPO_ACCESS_DENIED',
    UNSUPPORTED_FORMAT = 'UNSUPPORTED_FORMAT',
    PARSE_FAILED = 'PARSE_FAILED',
    CLONE_FAILED = 'CLONE_FAILED',
    CREATE_REPO_FAILED = 'CREATE_REPO_FAILED',
    GENERATION_FAILED = 'GENERATION_FAILED',
    AI_EXTRACTION_FAILED = 'AI_EXTRACTION_FAILED',
    UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}
