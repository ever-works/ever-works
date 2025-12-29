import { Transform } from 'class-transformer';
import {
    IsBoolean,
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    IsUrl,
    MaxLength,
    Min,
} from 'class-validator';
import { sanitizeName } from '../utils/sanitize.util';
import { ImportSourceType } from '../entities/directory.entity';

export enum ImportSourceTypeEnum {
    DATA_REPO = 'data_repo',
    AWESOME_README = 'awesome_readme',
    LINK_EXISTING = 'link_existing',
}

export class AnalyzeRepositoryDto {
    @IsUrl({}, { message: 'Please provide a valid GitHub URL' })
    @IsNotEmpty()
    sourceUrl: string;
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
        itemCount?: number;
        categoryCount?: number;
    };
    error?: string;
}

export class ImportDirectoryDto {
    @IsUrl({}, { message: 'Please provide a valid GitHub URL' })
    @IsNotEmpty()
    sourceUrl: string;

    @IsEnum(ImportSourceTypeEnum)
    sourceType: ImportSourceTypeEnum;

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

export class GitHubRepoDto {
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
}

export class GetUserRepositoriesResponseDto {
    repositories: GitHubRepoDto[];
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
