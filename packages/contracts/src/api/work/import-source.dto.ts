import type { ProvidersDto } from '../generator/providers.dto.js';
import type { WorkScheduleCadence } from './schedule.enum.js';
import type { AppSourceBlueprintMatchSource, AppSourceRepositoryType, AppUpstreamRef } from '../../apps/app-source.js';

export const IMPORT_SOURCE_TYPES = ['data_repo', 'awesome_readme', 'link_existing', 'works_config'] as const;

export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

export const AWESOME_README_IMPORT_MODES = ['clone', 'reuse_source'] as const;

export type AwesomeReadmeImportMode = (typeof AWESOME_README_IMPORT_MODES)[number];

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
	/**
	 * Which kind of import produced this record — and, since APW-01, that an
	 * **App Work** did.
	 *
	 * The widening is additive (APW-01 plan §3.2, `plan.md:310`): `IMPORT_SOURCE_TYPES`
	 * keeps its four members and every existing reader still sees the four
	 * `ImportSourceType` values it always did. The three `app_*` members are a
	 * separate closed set (`APP_SOURCE_REPOSITORY_TYPES`), so an imported entry can
	 * never become an App Work and an App Work can never be mistaken for an import
	 * (APW-01 FR-54). `supportsWorkSourceSync` answers `false` for all three: an App
	 * Work's repository is not an import source.
	 */
	type: ImportSourceType | AppSourceRepositoryType;
	importedAt: TImportedAt;
	relatedRepositories?: RelatedRepositories;
	worksConfig?: WorksConfigSnapshot;
	/**
	 * APW-01 — the repository a `fork` or a `private-copy` App Work follows.
	 *
	 * **Absent for a `link`**, which has no upstream at all. The field lives on the
	 * shared shape (rather than only on `AppSourceRecord`) so a reader of this DTO
	 * can describe an App Work without importing the App-source module
	 * (`plan.md:310-317`).
	 */
	upstream?: AppUpstreamRef;
	/** APW-01 — the Blueprint shown in the create preview; APW-03 applies it on ready. */
	blueprintId?: string;
	/** APW-01 — how that Blueprint was matched, so every reader sees the same answer. */
	blueprintMatchSource?: AppSourceBlueprintMatchSource;
	/** APW-01 — true only when this App Work's creation made the fork or private copy (R-4). */
	createdByThisWork?: boolean;
	/**
	 * APW-01 — the member's decline of FR-29a's automatic start.
	 *
	 * Written only when the member declined, so an absent field means "on" and no
	 * existing row or caller changes meaning (`plan.md:240`, §4.2 step 10).
	 */
	autoProvision?: boolean;
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
	awesomeReadmeImportMode?: AwesomeReadmeImportMode;
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
