import { Transform, Type } from 'class-transformer';
import {
    IsBoolean,
    IsIn,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    IsUrl,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import { sanitizeName } from '../utils/sanitize.util';
import { IMPORT_SOURCE_TYPES, type ImportSourceType } from '@ever-works/contracts/api';
import { ProvidersDto } from '../items-generator/dto';

export const ImportSourceTypeEnum = {
    DATA_REPO: IMPORT_SOURCE_TYPES[0],
    AWESOME_README: IMPORT_SOURCE_TYPES[1],
    LINK_EXISTING: IMPORT_SOURCE_TYPES[2],
    WORKS_CONFIG: IMPORT_SOURCE_TYPES[3],
} as const satisfies Record<string, ImportSourceType>;

export type ImportSourceTypeEnum = (typeof ImportSourceTypeEnum)[keyof typeof ImportSourceTypeEnum];

export class ImportEnrichmentConfigDto {
    @IsOptional()
    @IsNumber()
    expansionFactor?: number; // target ratio of final/seed items (default 2.5)
}

export class AnalyzeRepositoryDto {
    @IsUrl({}, { message: 'Please provide a valid repository URL' })
    @IsNotEmpty()
    sourceUrl: string;

    @IsOptional()
    @IsString()
    gitProvider?: string;
}

export class AnalyzeRepositoryResponseDto {
    sourceUrl: string;
    owner: string;
    repo: string;
    detectedType: ImportSourceType | null;
    isPublic: boolean;
    requiresAuth: boolean;
    structure?: {
        hasConfig: boolean;
        hasDataFolder: boolean;
        hasReadme: boolean;
        hasWorksConfig?: boolean;
        isMultiFile?: boolean;
        itemCount?: number;
        categoryCount?: number;
    };
    worksConfig?: {
        name?: string;
        initialPrompt?: string;
        model?: string;
        websiteRepo?: string;
        scheduleCadence?: string | null;
        providers?: ProvidersDto;
    };
    relatedDataRepo?: { name: string; owner: string };
    baseSlug?: string;
    slugConflict?: {
        hasConflict: boolean;
        conflictingRepos: string[];
        suggestedSlug: string;
    };
    hasDataRepoWriteAccess?: boolean;
    error?: string;
}

export class ImportDirectoryDto {
    @IsUrl({}, { message: 'Please provide a valid repository URL' })
    @IsNotEmpty()
    sourceUrl: string;

    @IsIn(IMPORT_SOURCE_TYPES)
    sourceType: ImportSourceType;

    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name: string;

    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    owner?: string;

    @IsOptional()
    @IsBoolean()
    organization?: boolean;

    @IsOptional()
    @IsBoolean()
    createMissingRepos?: boolean;

    @IsOptional()
    @IsBoolean()
    sync?: boolean;

    @IsOptional()
    @IsBoolean()
    restoreWorksConfig?: boolean;

    @IsString()
    @IsNotEmpty({ message: 'Git provider is required' })
    gitProvider: string;

    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    deployProvider?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => ProvidersDto)
    providers?: ProvidersDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => ImportEnrichmentConfigDto)
    enrichmentConfig?: ImportEnrichmentConfigDto;
}

export class ImportDirectoryResponseDto {
    status: 'pending' | 'success' | 'error';
    directoryId?: string;
    historyId?: string;
    message: string;
}

export class ImportProgressDto {
    directoryId: string;
    status: 'pending' | 'importing' | 'completed' | 'failed';
    progress?: number;
    currentStep?: string;
    itemsImported?: number;
    totalItems?: number;
    error?: string;
}

/**
 * Generic Git repository DTO for provider-agnostic repository data.
 */
export class GitRepoDto {
    id: number;
    name: string;
    full_name: string;
    owner: string;
    description: string | null;
    html_url: string;
    private: boolean;
    updated_at: string;
    default_branch: string;
}

export class GetUserRepositoriesDto {
    @IsString()
    @IsNotEmpty()
    gitProvider: string;

    @IsOptional()
    @IsNumber()
    @Min(1)
    page?: number;

    @IsOptional()
    @IsNumber()
    @Min(1)
    perPage?: number;

    @IsOptional()
    @IsString()
    search?: string;

    @IsOptional()
    @IsString()
    owner?: string;

    @IsOptional()
    @IsIn(['user', 'org'])
    type?: 'user' | 'org';
}

export class GetUserRepositoriesResponseDto {
    repositories: GitRepoDto[];
    total: number;
    page: number;
    perPage: number;
    hasMore: boolean;
}

export interface RelatedRepoStatus {
    exists: boolean;
    name: string | null;
    hasWriteAccess?: boolean;
}

export class AnalyzeForLinkingResponseDto {
    canLink: boolean;
    hasWriteAccess: boolean;
    relatedRepos: {
        data: RelatedRepoStatus & { exists: true; name: string };
        markdown: RelatedRepoStatus;
        website: RelatedRepoStatus;
    };
    itemCount?: number;
    categoryCount?: number;
    error?: string;
}
