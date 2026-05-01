import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import {
    GenerateStatusType,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    DirectoryMemberRole,
} from './enums';
import {
    GenerationMethod,
    type DirectoryScheduleDto as ContractDirectoryScheduleDto,
    type UpdateDirectorySchedulePayload as ContractUpdateDirectorySchedulePayload,
    type DirectoryGenerationHistoryResponse,
    type SourceValidationSettingsDto,
    type UpdateSourceValidationPayload,
    type GenerationStepLog,
    type AnalyzeRepositoryResponseDto as ContractAnalyzeRepositoryResponseDto,
    type ImportDirectoryDto as ContractImportDirectoryDto,
    type ImportEnrichmentConfig as ContractImportEnrichmentConfig,
    type ImportSourceType as ContractImportSourceType,
    type RelatedRepositories as ContractRelatedRepositories,
    type RepoVisibility as ContractRepoVisibility,
    type RepositoryTarget as ContractRepositoryTarget,
    type SourceRepository as ContractSourceRepository,
    type WorksConfigSnapshot as ContractWorksConfigSnapshot,
} from '@ever-works/contracts/api';
import { APIResponse, ItemData, Category, Tag, Collection } from './types';
import { CreateItemsGeneratorDto, ItemsGeneratorResponse } from './items-generator';

// Re-export directory types from contracts for convenience
export type {
    DirectoryScheduleAllowedCadence,
    GenerationMetrics,
    GenerationStepLog,
    DirectoryGenerationHistoryEntry,
    DirectoryGenerationHistoryResponse,
    SourceValidationSettingsDto,
    UpdateSourceValidationPayload,
} from '@ever-works/contracts/api';

export type DirectoryScheduleDto = ContractDirectoryScheduleDto;

export type UpdateDirectorySchedulePayload = ContractUpdateDirectorySchedulePayload & {
    runImmediately?: boolean;
};

export type ImportSourceType = ContractImportSourceType;
export type RepositoryTarget = ContractRepositoryTarget;
export type RelatedRepositories = ContractRelatedRepositories;
export type WorksConfigSnapshot = ContractWorksConfigSnapshot;
export type SourceRepository = ContractSourceRepository<string>;
export type RepoVisibility = ContractRepoVisibility;
export type ImportEnrichmentConfig = ContractImportEnrichmentConfig;
export type AnalyzeRepositoryResponseDto = ContractAnalyzeRepositoryResponseDto;
export type ImportDirectoryDto = ContractImportDirectoryDto;

export interface MarkdownReadmeConfig {
    header?: string;
    overwriteDefaultHeader?: boolean;
    footer?: string;
    overwriteDefaultFooter?: boolean;
}

export interface CreateDirectoryDto {
    slug: string;
    name: string;
    description: string;
    owner?: string;
    organization: boolean;
    gitProvider?: string;
    deployProvider?: string;
    websiteTemplateId?: string;
    readmeConfig?: MarkdownReadmeConfig;
}

export interface UpdateDirectoryDto {
    name?: string;
    description?: string;
    owner?: string;
    organization?: boolean;
    deployProvider?: string;
    websiteTemplateId?: string;
    readmeConfig?: MarkdownReadmeConfig;
    websiteTemplateAutoUpdate?: boolean;
    websiteTemplateUseBeta?: boolean;
    communityPrEnabled?: boolean;
    communityPrAutoClose?: boolean;
    committerName?: string | null;
    committerEmail?: string | null;
}

export interface DeleteDirectoryDto {
    delete_data_repository?: boolean;
    delete_markdown_repository?: boolean;
    delete_website_repository?: boolean;
}

export interface GenerateDirectoryDetailDto {
    directory_name: string;
    prompt: string;
    ai_provider?: string;
}

export type GenerateStatus = {
    status: GenerateStatusType;
    /** Current step ID (e.g., "prompt-processing") */
    step?: string;
    /** Human-readable step name (from pipeline plugin) */
    stepName?: string;
    /** Current step index (0-based) */
    stepIndex?: number;
    /** Total number of steps in the pipeline */
    totalSteps?: number;
    /** Progress percentage (0-100) */
    progress?: number;
    /** Number of items processed so far */
    itemsProcessed?: number;
    /** Error message if status is ERROR */
    error?: string;
    /** Warnings from degraded services (e.g. circuit breaker tripped) */
    warnings?: string[];
    /** Recent log entries for live display during generation */
    recentLogs?: GenerationStepLog[];
};

export type GetProjectsReadyState =
    | 'BUILDING'
    | 'ERROR'
    | 'INITIALIZING'
    | 'QUEUED'
    | 'READY'
    | 'CANCELED'
    | 'TIMEOUT';

// Response Types
export interface Directory {
    id: string;
    slug: string;
    name: string;
    description: string;
    owner?: string;
    website?: string;
    organization: boolean;
    gitProvider: string;
    deployProvider?: string;
    readmeConfig?: MarkdownReadmeConfig;
    generateStatus?: GenerateStatus;
    createdAt: string;
    updatedAt: string;
    itemsCount?: number;
    lastPullRequest?: { main?: PRUpdate; data?: PRUpdate };
    deploymentState?: GetProjectsReadyState;
    deploymentStartedAt?: string;
    scheduledUpdatesEnabled?: boolean;
    scheduledCadence?: DirectoryScheduleCadence | null;
    scheduledNextRunAt?: string | null;
    scheduledStatus?: DirectoryScheduleStatus | null;
    // User's role in this directory (owner, manager, editor, viewer)
    // This is computed based on user's access - creator is always 'owner'
    userRole?: DirectoryMemberRole;
    // Website template auto-update settings
    websiteTemplateId?: string;
    websiteTemplateAutoUpdate?: boolean;
    websiteTemplateUseBeta?: boolean;
    websiteTemplateLastCommit?: string | null;
    websiteTemplateLastError?: string | null;
    websiteTemplateLastUpdatedAt?: string | null;
    websiteTemplateLastCheckedAt?: string | null;
    // Community PR Processing
    communityPrEnabled?: boolean;
    communityPrAutoClose?: boolean;
    // Import Source FIELDS
    sourceRepository?: SourceRepository;
    repoVisibility?: RepoVisibility;
    // Git committer overrides
    committerName?: string | null;
    committerEmail?: string | null;
}

export interface DirectoriesResponse {
    directories: Directory[];
    total: number;
    limit?: number;
    offset?: number;
}

export interface DirectoryStatsResponse {
    totalDirectories: number;
    totalItems: number;
    activeWebsites: number;
    generatingCount: number;
}

export interface DeleteDirectoryResponse {
    status: 'success' | 'error' | 'pending';
    slug: string;
    message: string;
    deleted_repositories?: string[];
}

export interface DirectoryDetails {
    name: string;
    slug: string;
    description: string;
    keywords: string[];
    categories: string[];
}

export interface UpdateReadmeResponse {
    status: 'success' | 'skipped';
    updated: boolean;
    slug: string;
    message?: string;
}

export type PRUpdate = {
    branch: string;
    title: string;
    body: string;
    number?: number;
    url?: string;
};

export interface DirectoryConfig {
    company_name?: string;
    company_website?: string;
    content_table?: boolean;
    item_name?: string;
    items_name?: string;
    copyright_year?: number;
    paging_mode?: string;
    autoapproval?: boolean;
    locale?: string;
    company_owner?: string;
    company_owner_website?: string;
    logo?: {
        light?: string;
        dark?: string;
    };
    favicon?: {
        light?: string;
        dark?: string;
    };
    title?: string;
    description?: string;
    keywords?: string[];
    categories?: string[];
    author?: string;
    url?: string;
    image?: string;
    twitter?: {
        card?: string;
        title?: string;
        description?: string;
    };
    metadata?: {
        initial_prompt?: string;
        generation_method?: GenerationMethod;
        pr_update?: PRUpdate | null;
        last_request_data?: CreateItemsGeneratorDto;
    } & Record<string, unknown>;
}

export interface DirectoryCount {
    items: number;
    categories: number;
    tags: number;
    comparisons: number;
}

export interface DirectoryCategoriesTags {
    categories: string[];
    tags: string[];
    collections: string[];
}

// Website Settings Types
export interface CustomMenuItem {
    label: string;
    path: string;
    target?: '_self' | '_blank';
    icon?: string;
}

export interface WebsiteSettingsHeader {
    submit_enabled?: boolean;
    pricing_enabled?: boolean;
    layout_enabled?: boolean;
    language_enabled?: boolean;
    theme_enabled?: boolean;
    layout_default?: string;
    pagination_default?: string;
    theme_default?: string;
}

export interface WebsiteSettingsHomepage {
    hero_enabled?: boolean;
    search_enabled?: boolean;
    default_view?: string;
    default_sort?: string;
}

export interface WebsiteSettingsFooter {
    subscribe_enabled?: boolean;
    version_enabled?: boolean;
    theme_selector_enabled?: boolean;
}

export interface WebsiteSettings {
    categories_enabled?: boolean;
    companies_enabled?: boolean;
    tags_enabled?: boolean;
    surveys_enabled?: boolean;
    header?: WebsiteSettingsHeader;
    homepage?: WebsiteSettingsHomepage;
    footer?: WebsiteSettingsFooter;
}

export interface WebsiteSettingsResponse {
    company_name: string;
    company_website: string;
    settings: WebsiteSettings;
    custom_menu: {
        header: CustomMenuItem[];
        footer: CustomMenuItem[];
    };
}

export interface UpdateWebsiteSettingsDto {
    company_name?: string;
    company_website?: string;
    categories_enabled?: boolean;
    companies_enabled?: boolean;
    tags_enabled?: boolean;
    surveys_enabled?: boolean;
    header?: WebsiteSettingsHeader;
    homepage?: WebsiteSettingsHomepage;
    footer?: WebsiteSettingsFooter;
    custom_menu?: {
        header?: CustomMenuItem[];
        footer?: CustomMenuItem[];
    };
}

export interface SyncDirectoryResponse {
    status: 'success' | 'error';
    updated?: string[];
    message?: string;
}

export interface AnalyzeRepositoryDto {
    sourceUrl: string;
    gitProvider?: string;
}

export interface ImportDirectoryResponseDto {
    status: 'pending' | 'success' | 'error';
    directoryId?: string;
    historyId?: string;
    message: string;
}

export interface GitRepoDto {
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

export interface GetUserRepositoriesResponseDto {
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

export interface AnalyzeForLinkingResponseDto {
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

export type RepositoryType = 'data' | 'directory' | 'website';

export interface RepositoryStatus {
    type: RepositoryType;
    name: string;
    url: string;
    isPrivate: boolean;
    exists: boolean;
}

// Advanced Prompts Types
export interface DirectoryAdvancedPrompts {
    id: string;
    directoryId: string;
    relevanceAssessment?: string | null;
    itemGeneration?: string | null;
    itemExtraction?: string | null;
    searchQuery?: string | null;
    categorization?: string | null;
    deduplication?: string | null;
    sourceValidation?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface UpdateDirectoryAdvancedPromptsDto {
    relevanceAssessment?: string | null;
    itemGeneration?: string | null;
    itemExtraction?: string | null;
    searchQuery?: string | null;
    categorization?: string | null;
    deduplication?: string | null;
    sourceValidation?: string | null;
}

export interface ComparisonDimension {
    name: string;
    item_a_summary: string;
    item_b_summary: string;
    item_a_score?: number;
    item_b_score?: number;
    winner?: 'item_a' | 'item_b' | 'tie';
}

export interface ComparisonSource {
    title: string;
    url: string;
    note?: string;
}

export interface ComparisonData {
    id: string;
    slug: string;
    title: string;
    item_a_slug: string;
    item_b_slug: string;
    item_a_name: string;
    item_b_name: string;
    category: string;
    summary: string;
    verdict: string;
    verdict_winner?: 'item_a' | 'item_b' | 'tie';
    dimensions: ComparisonDimension[];
    sources: ComparisonSource[];
    generated_at: string;
}

export interface ComparisonResult {
    status: 'success' | 'skipped' | 'error';
    slug?: string;
    message: string;
}

export const directoryAPI = {
    // Get all directories with pagination and search
    getAll: async (options?: { limit?: number; offset?: number; search?: string }) => {
        const params = new URLSearchParams();
        if (options?.limit !== undefined) params.append('limit', options.limit.toString());
        if (options?.offset !== undefined) params.append('offset', options.offset.toString());
        if (options?.search) params.append('search', options.search);
        const query = params.toString() ? `?${params.toString()}` : '';

        return serverFetch<DirectoriesResponse>(`/directories${query}`);
    },

    // Get aggregated stats for the current user's directories
    getStats: async () => {
        return serverFetch<DirectoryStatsResponse>(`/directories/stats`);
    },

    // Get a directory by ID
    get: async (id: string) => {
        return serverFetch<APIResponse<{ directory: Directory }>>(`/directories/${id}`);
    },

    // Create a new directory
    create: async (data: CreateDirectoryDto) => {
        return serverMutation<APIResponse<{ directory: Directory }>>({
            endpoint: '/directories',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Update a directory by ID
    update: async (id: string, data: UpdateDirectoryDto) => {
        return serverMutation<APIResponse<{ directory: Directory }>>({
            endpoint: `/directories/${id}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // Delete a directory by ID
    delete: async (id: string, data: DeleteDirectoryDto) => {
        return serverMutation<DeleteDirectoryResponse>({
            endpoint: `/directories/${id}/delete`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Get directory items
    getItems: async (id: string) => {
        return serverFetch<APIResponse<{ items: ItemData[] }>>(`/directories/${id}/items`);
    },

    // Get directory config
    getConfig: async (id: string) => {
        return serverFetch<APIResponse<{ config: DirectoryConfig }>>(`/directories/${id}/config`);
    },

    // Get directory count
    getCount: async (id: string) => {
        return serverFetch<APIResponse<DirectoryCount>>(`/directories/${id}/count`);
    },

    // Get directory categories and tags
    getCategoriesTags: async (id: string) => {
        return serverFetch<APIResponse<DirectoryCategoriesTags>>(
            `/directories/${id}/categories-tags`,
        );
    },

    // Get directory generation history
    getHistory: async (
        id: string,
        options?: { limit?: number; offset?: number; activityType?: string },
    ) => {
        const params = new URLSearchParams();
        if (options?.limit !== undefined) params.append('limit', String(options.limit));
        if (options?.offset !== undefined) params.append('offset', String(options.offset));
        if (options?.activityType) params.append('activityType', options.activityType);
        const query = params.toString() ? `?${params.toString()}` : '';

        return serverFetch<APIResponse<DirectoryGenerationHistoryResponse>>(
            `/directories/${id}/history${query}`,
        );
    },

    // Generate directory details from name and prompt
    generateDetails: async (data: GenerateDirectoryDetailDto) => {
        return serverMutation<DirectoryDetails>({
            endpoint: '/directories/generate-details',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    getSchedule: async (id: string) => {
        return serverFetch<APIResponse<{ directoryId: string; schedule: DirectoryScheduleDto }>>(
            `/directories/${id}/schedule`,
        );
    },

    updateSchedule: async (id: string, data: UpdateDirectorySchedulePayload) => {
        return serverMutation<APIResponse<{ schedule: DirectoryScheduleDto }>>({
            endpoint: `/directories/${id}/schedule`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    cancelSchedule: async (id: string) => {
        return serverMutation<APIResponse<{ schedule: DirectoryScheduleDto }>>({
            endpoint: `/directories/${id}/schedule`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    runSchedule: async (id: string) => {
        return serverMutation<ItemsGeneratorResponse>({
            endpoint: `/directories/${id}/schedule/run`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    getSourceValidationSettings: async (id: string) => {
        return serverFetch<SourceValidationSettingsDto>(`/directories/${id}/source-validation`);
    },

    updateSourceValidationSettings: async (id: string, data: UpdateSourceValidationPayload) => {
        return serverMutation<SourceValidationSettingsDto>({
            endpoint: `/directories/${id}/source-validation`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    syncData: async (id: string) => {
        return serverMutation<SyncDirectoryResponse>({
            endpoint: `/directories/${id}/sync-data`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    updateReadme: async (id: string) => {
        return serverMutation<UpdateReadmeResponse>({
            endpoint: `/directories/${id}/update-readme`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Import methods
    analyzeRepository: async (data: AnalyzeRepositoryDto) => {
        return serverMutation<AnalyzeRepositoryResponseDto>({
            endpoint: '/directories/import/analyze',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    analyzeForLinking: async (data: AnalyzeRepositoryDto) => {
        return serverMutation<AnalyzeForLinkingResponseDto>({
            endpoint: '/directories/import/analyze-for-linking',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    importDirectory: async (data: ImportDirectoryDto) => {
        return serverMutation<ImportDirectoryResponseDto>({
            endpoint: '/directories/import',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    getUserRepositories: async (options: {
        gitProvider: string;
        page?: number;
        perPage?: number;
        search?: string;
        owner?: string;
        type?: 'user' | 'org';
    }) => {
        const params = new URLSearchParams();
        params.append('gitProvider', options.gitProvider);
        if (options.page !== undefined) params.append('page', String(options.page));
        if (options.perPage !== undefined) params.append('perPage', String(options.perPage));
        if (options.search) params.append('search', options.search);
        if (options.owner) params.append('owner', options.owner);
        if (options.type) params.append('type', options.type);
        const query = params.toString() ? `?${params.toString()}` : '';

        return serverFetch<GetUserRepositoriesResponseDto>(
            `/directories/import/repositories${query}`,
        );
    },

    // Repository Visibility
    getRepositoryVisibility: async (id: string) => {
        return serverFetch<RepositoryStatus[]>(`/directories/${id}/repositories/visibility`);
    },

    updateRepositoryVisibility: async (
        id: string,
        data: { repoType: RepositoryType; isPrivate: boolean },
    ) => {
        return serverMutation<RepositoryStatus>({
            endpoint: `/directories/${id}/repositories/visibility`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // Advanced Prompts
    getAdvancedPrompts: async (id: string) => {
        return serverFetch<APIResponse<{ advancedPrompts: DirectoryAdvancedPrompts | null }>>(
            `/directories/${id}/advanced-prompts`,
        );
    },

    updateAdvancedPrompts: async (id: string, data: UpdateDirectoryAdvancedPromptsDto) => {
        return serverMutation<APIResponse<{ advancedPrompts: DirectoryAdvancedPrompts }>>({
            endpoint: `/directories/${id}/advanced-prompts`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // Website Settings
    getWebsiteSettings: async (id: string) => {
        return serverFetch<APIResponse<WebsiteSettingsResponse>>(
            `/directories/${id}/website-settings`,
        );
    },

    updateWebsiteSettings: async (id: string, data: UpdateWebsiteSettingsDto) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/directories/${id}/website-settings`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // ============================================
    // Taxonomy CRUD Operations
    // ============================================

    // Categories
    createCategory: async (id: string, data: Partial<Category>) => {
        return serverMutation<APIResponse<{ category: Category }>>({
            endpoint: `/directories/${id}/categories`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateCategory: async (id: string, categoryId: string, data: Partial<Category>) => {
        return serverMutation<APIResponse<{ category: Category }>>({
            endpoint: `/directories/${id}/categories/${categoryId}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    deleteCategory: async (id: string, categoryId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/directories/${id}/categories/${categoryId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // Tags
    createTag: async (id: string, data: Partial<Tag>) => {
        return serverMutation<APIResponse<{ tag: Tag }>>({
            endpoint: `/directories/${id}/tags`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateTag: async (id: string, tagId: string, data: Partial<Tag>) => {
        return serverMutation<APIResponse<{ tag: Tag }>>({
            endpoint: `/directories/${id}/tags/${tagId}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    deleteTag: async (id: string, tagId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/directories/${id}/tags/${tagId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // Collections
    createCollection: async (id: string, data: Partial<Collection>) => {
        return serverMutation<APIResponse<{ collection: Collection }>>({
            endpoint: `/directories/${id}/collections`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateCollection: async (id: string, collectionId: string, data: Partial<Collection>) => {
        return serverMutation<APIResponse<{ collection: Collection }>>({
            endpoint: `/directories/${id}/collections/${collectionId}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    deleteCollection: async (id: string, collectionId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/directories/${id}/collections/${collectionId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // ─── Comparisons ────────────────────────────────────────────────

    getComparisons: async (id: string) => {
        return serverFetch<ComparisonData[]>(`/directories/${id}/comparisons`);
    },

    getComparison: async (id: string, slug: string) => {
        return serverFetch<{
            comparison: ComparisonData;
            markdown?: string;
            extendedAnalysisMarkdown?: string;
        }>(`/directories/${id}/comparisons/${slug}`);
    },

    getRemainingComparisonCount: async (id: string) => {
        return serverFetch<{ count: number }>(`/directories/${id}/comparisons/remaining-count`);
    },

    getComparisonGenerationStatus: async (id: string) => {
        return serverFetch<{
            generating: boolean;
            stage?: string;
            itemAName?: string;
            itemBName?: string;
            startedAt?: string;
        }>(`/directories/${id}/comparisons/generation-status`);
    },

    generateNextComparison: async (id: string) => {
        return serverMutation<ComparisonResult>({
            endpoint: `/directories/${id}/comparisons/generate`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    generateManualComparison: async (id: string, itemASlug: string, itemBSlug: string) => {
        return serverMutation<ComparisonResult>({
            endpoint: `/directories/${id}/comparisons/generate-manual`,
            data: { itemASlug, itemBSlug },
            method: 'POST',
            wrapInData: false,
        });
    },

    deleteComparison: async (id: string, slug: string) => {
        return serverMutation<ComparisonResult>({
            endpoint: `/directories/${id}/comparisons/${slug}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
