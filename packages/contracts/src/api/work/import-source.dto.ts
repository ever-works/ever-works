import type { ProvidersDto } from '../generator/providers.dto.js';
import type { WorkScheduleCadence } from './schedule.enum.js';

export const IMPORT_SOURCE_TYPES = ['data_repo', 'awesome_readme', 'link_existing', 'works_config'] as const;

export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

/**
 * NOTE: the 'directory' role name is preserved (not renamed to 'work')
 * because this string is also the KEY used in the persisted JSON column
 * `directories.sourceRepository.relatedRepositories` for every existing
 * production work. Renaming this string makes `relatedRepositories['work']`
 * miss the persisted `relatedRepositories['directory']` value, falling back
 * to a synthesized owner that no longer matches the real GitHub repo.
 */
export type RepositoryRole = 'data' | 'directory' | 'website';

export interface RepositoryTarget {
	owner?: string;
	repo: string;
}

export interface RelatedRepositories {
	data?: RepositoryTarget;
	/**
	 * Persisted in DB as the 'directory' key — see RepositoryRole note.
	 * Despite the new product naming, this property name stays as `directory`
	 * because it's the JSON key in already-stored `directories.sourceRepository`.
	 */
	directory?: RepositoryTarget;
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

/**
 * Persisted in `directories.repoVisibility` (JSON column). The `directory`
 * key (formerly the entity's main repo) is preserved so existing rows
 * continue to round-trip correctly. Renaming to `work` would silently
 * drop the saved value on read.
 */
export interface RepoVisibility {
	data: boolean;
	website: boolean;
	directory: boolean;
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
