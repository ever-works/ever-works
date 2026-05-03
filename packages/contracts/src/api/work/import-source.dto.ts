import type { ProvidersDto } from '../generator/providers.dto.js';
import type { WorkScheduleCadence } from './schedule.enum.js';

export const IMPORT_SOURCE_TYPES = ['data_repo', 'awesome_readme', 'link_existing', 'works_config'] as const;

export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

export type RepositoryRole = 'data' | 'work' | 'website';

export interface RepositoryTarget {
	owner?: string;
	repo: string;
}

export interface RelatedRepositories {
	data?: RepositoryTarget;
	work?: RepositoryTarget;
	website?: RepositoryTarget;
}

export interface WorksConfigSnapshot {
	name?: string;
	initialPrompt?: string;
	model?: string;
	websiteRepo?: string;
	scheduleCadence?: WorkScheduleCadence | null;
	providers?: ProvidersDto;
}

export interface SourceRepository<TImportedAt = string> {
	url: string;
	owner: string;
	repo: string;
	type: ImportSourceType;
	importedAt: TImportedAt;
	relatedRepositories?: RelatedRepositories;
	worksConfig?: WorksConfigSnapshot;
}

export interface RepoVisibility {
	data: boolean;
	website: boolean;
	work: boolean;
}

export interface ImportEnrichmentConfig {
	expansionFactor?: number;
}

export interface AnalyzeRepositoryResponseDto {
	sourceUrl: string;
	owner: string;
	repo: string;
	detectedType: ImportSourceType | null;
	isPublic: boolean;
	requiresAuth: boolean;
	structure?: {
		hasDataFolder: boolean;
		hasConfig: boolean;
		hasReadme: boolean;
		hasWorksConfig?: boolean;
		isMultiFile?: boolean;
		itemCount?: number;
		categoryCount?: number;
	};
	worksConfig?: WorksConfigSnapshot;
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

export interface ImportWorkDto {
	sourceUrl: string;
	sourceType: ImportSourceType;
	name: string;
	owner?: string;
	organization?: boolean;
	gitProvider: string;
	deployProvider?: string;
	createMissingRepos?: boolean;
	sync?: boolean;
	providers?: ProvidersDto;
	restoreWorksConfig?: boolean;
	enrichmentConfig?: ImportEnrichmentConfig;
}
