import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import {
    GenerateStatusType,
    WorkScheduleCadence,
    WorkScheduleStatus,
    WorkMemberRole,
} from './enums';
import {
    GenerationMethod,
    type WorkScheduleDto as ContractWorkScheduleDto,
    type UpdateWorkSchedulePayload as ContractUpdateWorkSchedulePayload,
    type WorkGenerationHistoryResponse,
    type SourceValidationSettingsDto,
    type UpdateSourceValidationPayload,
    type GenerationStepLog,
    type AnalyzeRepositoryResponseDto as ContractAnalyzeRepositoryResponseDto,
    type ImportWorkDto as ContractImportWorkDto,
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

// Re-export work types from contracts for convenience
export type {
    WorkScheduleAllowedCadence,
    GenerationMetrics,
    GenerationStepLog,
    WorkGenerationHistoryEntry,
    WorkGenerationHistoryResponse,
    SourceValidationSettingsDto,
    UpdateSourceValidationPayload,
} from '@ever-works/contracts/api';

export type WorkScheduleDto = ContractWorkScheduleDto;

export type UpdateWorkSchedulePayload = ContractUpdateWorkSchedulePayload & {
    runImmediately?: boolean;
};

export type ImportSourceType = ContractImportSourceType;
export type RepositoryTarget = ContractRepositoryTarget;
export type RelatedRepositories = ContractRelatedRepositories;
export type RepoVisibility = ContractRepoVisibility;
export type ImportEnrichmentConfig = ContractImportEnrichmentConfig;
export type AnalyzeRepositoryResponseDto = ContractAnalyzeRepositoryResponseDto;
export type ImportWorkDto = ContractImportWorkDto;

export interface MarkdownReadmeConfig {
    header?: string;
    overwriteDefaultHeader?: boolean;
    footer?: string;
    overwriteDefaultFooter?: boolean;
}

export interface WebsiteTemplateOption {
    id: string;
    name: string;
    description: string;
    isDefault: boolean;
    sourceType: 'built_in' | 'custom';
    originType: 'standard' | 'forked' | 'custom_url';
}

export interface CreateWorkDto {
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

export interface UpdateWorkDto {
    name?: string;
    description?: string;
    owner?: string;
    organization?: boolean;
    deployProvider?: string;
    websiteTemplateId?: string | null;
    readmeConfig?: MarkdownReadmeConfig;
    websiteTemplateAutoUpdate?: boolean;
    websiteTemplateUseBeta?: boolean;
    communityPrEnabled?: boolean;
    communityPrAutoClose?: boolean;
    committerName?: string | null;
    committerEmail?: string | null;
    /** EW-120 Activity Feed sync transport. */
    activitySyncMode?: 'pull' | 'push' | 'disabled';
}

export interface DeleteWorkDto {
    delete_data_repository?: boolean;
    delete_markdown_repository?: boolean;
    delete_website_repository?: boolean;
}

export interface GenerateWorkDetailDto {
    work_name: string;
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

export type SourceRepositoryAuth =
    | {
          mode: 'github_app_installation';
          providerId: 'github';
          installationId: string;
          installationRepositoryId?: string;
          repoFullName?: string;
      }
    | {
          mode: 'none';
      };

export type WorksConfigSnapshot = ContractWorksConfigSnapshot & {
    additionalAgentsCount?: number;
};

export type SourceRepository = ContractSourceRepository<string> & {
    worksConfig?: WorksConfigSnapshot;
    auth?: SourceRepositoryAuth;
};

// Response Types
export interface Work {
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
    scheduledCadence?: WorkScheduleCadence | null;
    scheduledNextRunAt?: string | null;
    scheduledStatus?: WorkScheduleStatus | null;
    // User's role in this work (owner, manager, editor, viewer)
    // This is computed based on user's access - creator is always 'owner'
    userRole?: WorkMemberRole;
    // Website template auto-update settings
    websiteTemplateId?: string;
    websiteTemplateAutoUpdate?: boolean;
    websiteTemplateUseBeta?: boolean;
    websiteTemplateLastCommit?: string | null;
    websiteTemplateLastError?: string | null;
    websiteTemplateLastUpdatedAt?: string | null;
    websiteTemplateLastCheckedAt?: string | null;
    websiteRepositoryInitialized?: boolean;
    // Community PR Processing
    communityPrEnabled?: boolean;
    communityPrAutoClose?: boolean;
    // Import Source FIELDS
    sourceRepository?: SourceRepository;
    repoVisibility?: RepoVisibility;
    // Git committer overrides
    committerName?: string | null;
    committerEmail?: string | null;
    // EW-120 Activity Feed sync (dual-mode)
    activitySyncMode?: 'pull' | 'push' | 'disabled';
    platformSyncLastSuccessAt?: string | null;
    platformSyncLastErrorAt?: string | null;
    platformSyncLastErrorMessage?: string | null;
}

export interface WorksResponse {
    works: Work[];
    total: number;
    limit?: number;
    offset?: number;
}

export interface WorkStatsResponse {
    totalWorks: number;
    totalItems: number;
    activeWebsites: number;
    generatingCount: number;
}

export interface DeleteWorkResponse {
    status: 'success' | 'error' | 'pending';
    slug: string;
    message: string;
    deleted_repositories?: string[];
}

export interface WorkDetails {
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

export interface WorkConfig {
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

export interface WorkCount {
    items: number;
    categories: number;
    tags: number;
    comparisons: number;
}

export interface WorkCategoriesTags {
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
    /** Enables CSV/Excel bulk export of items (EW-533). */
    export_enabled?: boolean;
    /** Enables CSV/Excel bulk import of items (EW-533). */
    import_enabled?: boolean;
    /** Per-directory cap on rows accepted by a single import upload (default 500). */
    import_max_rows?: number;
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
    export_enabled?: boolean;
    import_enabled?: boolean;
    import_max_rows?: number;
    header?: WebsiteSettingsHeader;
    homepage?: WebsiteSettingsHomepage;
    footer?: WebsiteSettingsFooter;
    custom_menu?: {
        header?: CustomMenuItem[];
        footer?: CustomMenuItem[];
    };
}

export interface SyncWorkResponse {
    status: 'success' | 'error';
    updated?: string[];
    message?: string;
}

export interface AnalyzeRepositoryDto {
    sourceUrl: string;
    gitProvider?: string;
}

export interface ImportWorkResponseDto {
    status: 'pending' | 'success' | 'error';
    workId?: string;
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

export type RepositoryType = 'data' | 'work' | 'website';

export interface RepositoryStatus {
    type: RepositoryType;
    name: string;
    url: string;
    isPrivate: boolean;
    exists: boolean;
}

// Advanced Prompts Types
export interface WorkAdvancedPrompts {
    id: string;
    workId: string;
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

export interface UpdateWorkAdvancedPromptsDto {
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

export const workAPI = {
    // Get all works with pagination and search
    getAll: async (options?: { limit?: number; offset?: number; search?: string }) => {
        const params = new URLSearchParams();
        if (options?.limit !== undefined) params.append('limit', options.limit.toString());
        if (options?.offset !== undefined) params.append('offset', options.offset.toString());
        if (options?.search) params.append('search', options.search);
        const query = params.toString() ? `?${params.toString()}` : '';

        return serverFetch<WorksResponse>(`/works${query}`);
    },

    // Get aggregated stats for the current user's works
    getStats: async () => {
        return serverFetch<WorkStatsResponse>(`/works/stats`);
    },

    // Get a work by ID
    get: async (id: string) => {
        return serverFetch<APIResponse<{ work: Work }>>(`/works/${id}`);
    },

    getWebsiteTemplates: async () => {
        return serverFetch<APIResponse<{ templates: WebsiteTemplateOption[] }>>(
            `/works/website-templates`,
        );
    },

    // Create a new work
    create: async (data: CreateWorkDto) => {
        return serverMutation<APIResponse<{ work: Work }>>({
            endpoint: '/works',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Update a work by ID
    update: async (id: string, data: UpdateWorkDto) => {
        return serverMutation<APIResponse<{ work: Work }>>({
            endpoint: `/works/${id}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // Delete a work by ID
    delete: async (id: string, data: DeleteWorkDto) => {
        return serverMutation<DeleteWorkResponse>({
            endpoint: `/works/${id}/delete`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Get work items
    getItems: async (id: string) => {
        return serverFetch<APIResponse<{ items: ItemData[] }>>(`/works/${id}/items`);
    },

    // Get work config
    getConfig: async (id: string) => {
        return serverFetch<APIResponse<{ config: WorkConfig }>>(`/works/${id}/config`);
    },

    // Get work count
    getCount: async (id: string) => {
        return serverFetch<APIResponse<WorkCount>>(`/works/${id}/count`);
    },

    // Get work categories and tags
    getCategoriesTags: async (id: string) => {
        return serverFetch<APIResponse<WorkCategoriesTags>>(`/works/${id}/categories-tags`);
    },

    // Get work generation history
    getHistory: async (
        id: string,
        options?: { limit?: number; offset?: number; activityType?: string },
    ) => {
        const params = new URLSearchParams();
        if (options?.limit !== undefined) params.append('limit', String(options.limit));
        if (options?.offset !== undefined) params.append('offset', String(options.offset));
        if (options?.activityType) params.append('activityType', options.activityType);
        const query = params.toString() ? `?${params.toString()}` : '';

        return serverFetch<APIResponse<WorkGenerationHistoryResponse>>(
            `/works/${id}/history${query}`,
        );
    },

    // Generate work details from name and prompt
    generateDetails: async (data: GenerateWorkDetailDto) => {
        return serverMutation<WorkDetails>({
            endpoint: '/works/generate-details',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    getSchedule: async (id: string) => {
        return serverFetch<APIResponse<{ workId: string; schedule: WorkScheduleDto }>>(
            `/works/${id}/schedule`,
        );
    },

    updateSchedule: async (id: string, data: UpdateWorkSchedulePayload) => {
        return serverMutation<APIResponse<{ schedule: WorkScheduleDto }>>({
            endpoint: `/works/${id}/schedule`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    cancelSchedule: async (id: string) => {
        return serverMutation<APIResponse<{ schedule: WorkScheduleDto }>>({
            endpoint: `/works/${id}/schedule`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    runSchedule: async (id: string) => {
        return serverMutation<ItemsGeneratorResponse>({
            endpoint: `/works/${id}/schedule/run`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    getSourceValidationSettings: async (id: string) => {
        return serverFetch<SourceValidationSettingsDto>(`/works/${id}/source-validation`);
    },

    updateSourceValidationSettings: async (id: string, data: UpdateSourceValidationPayload) => {
        return serverMutation<SourceValidationSettingsDto>({
            endpoint: `/works/${id}/source-validation`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    syncData: async (id: string) => {
        return serverMutation<SyncWorkResponse>({
            endpoint: `/works/${id}/sync-data`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    updateReadme: async (id: string) => {
        return serverMutation<UpdateReadmeResponse>({
            endpoint: `/works/${id}/update-readme`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Import methods
    analyzeRepository: async (data: AnalyzeRepositoryDto) => {
        return serverMutation<AnalyzeRepositoryResponseDto>({
            endpoint: '/works/import/analyze',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    analyzeForLinking: async (data: AnalyzeRepositoryDto) => {
        return serverMutation<AnalyzeForLinkingResponseDto>({
            endpoint: '/works/import/analyze-for-linking',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    importWork: async (data: ImportWorkDto) => {
        return serverMutation<ImportWorkResponseDto>({
            endpoint: '/works/import',
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

        return serverFetch<GetUserRepositoriesResponseDto>(`/works/import/repositories${query}`);
    },

    // Repository Visibility
    getRepositoryVisibility: async (id: string) => {
        return serverFetch<RepositoryStatus[]>(`/works/${id}/repositories/visibility`);
    },

    updateRepositoryVisibility: async (
        id: string,
        data: { repoType: RepositoryType; isPrivate: boolean },
    ) => {
        return serverMutation<RepositoryStatus>({
            endpoint: `/works/${id}/repositories/visibility`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // Advanced Prompts
    getAdvancedPrompts: async (id: string) => {
        return serverFetch<APIResponse<{ advancedPrompts: WorkAdvancedPrompts | null }>>(
            `/works/${id}/advanced-prompts`,
        );
    },

    updateAdvancedPrompts: async (id: string, data: UpdateWorkAdvancedPromptsDto) => {
        return serverMutation<APIResponse<{ advancedPrompts: WorkAdvancedPrompts }>>({
            endpoint: `/works/${id}/advanced-prompts`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // Website Settings
    getWebsiteSettings: async (id: string) => {
        return serverFetch<APIResponse<WebsiteSettingsResponse>>(`/works/${id}/website-settings`);
    },

    updateWebsiteSettings: async (id: string, data: UpdateWebsiteSettingsDto) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/works/${id}/website-settings`,
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
            endpoint: `/works/${id}/categories`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateCategory: async (id: string, categoryId: string, data: Partial<Category>) => {
        return serverMutation<APIResponse<{ category: Category }>>({
            endpoint: `/works/${id}/categories/${categoryId}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    deleteCategory: async (id: string, categoryId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/works/${id}/categories/${categoryId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // Tags
    createTag: async (id: string, data: Partial<Tag>) => {
        return serverMutation<APIResponse<{ tag: Tag }>>({
            endpoint: `/works/${id}/tags`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateTag: async (id: string, tagId: string, data: Partial<Tag>) => {
        return serverMutation<APIResponse<{ tag: Tag }>>({
            endpoint: `/works/${id}/tags/${tagId}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    deleteTag: async (id: string, tagId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/works/${id}/tags/${tagId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // Collections
    createCollection: async (id: string, data: Partial<Collection>) => {
        return serverMutation<APIResponse<{ collection: Collection }>>({
            endpoint: `/works/${id}/collections`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateCollection: async (id: string, collectionId: string, data: Partial<Collection>) => {
        return serverMutation<APIResponse<{ collection: Collection }>>({
            endpoint: `/works/${id}/collections/${collectionId}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    deleteCollection: async (id: string, collectionId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/works/${id}/collections/${collectionId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // ─── Comparisons ────────────────────────────────────────────────

    getComparisons: async (id: string) => {
        return serverFetch<ComparisonData[]>(`/works/${id}/comparisons`);
    },

    getComparison: async (id: string, slug: string) => {
        return serverFetch<{
            comparison: ComparisonData;
            markdown?: string;
            extendedAnalysisMarkdown?: string;
        }>(`/works/${id}/comparisons/${slug}`);
    },

    getRemainingComparisonCount: async (id: string) => {
        return serverFetch<{ count: number }>(`/works/${id}/comparisons/remaining-count`);
    },

    getComparisonGenerationStatus: async (id: string) => {
        return serverFetch<{
            generating: boolean;
            stage?: string;
            itemAName?: string;
            itemBName?: string;
            startedAt?: string;
        }>(`/works/${id}/comparisons/generation-status`);
    },

    generateNextComparison: async (id: string) => {
        return serverMutation<ComparisonResult>({
            endpoint: `/works/${id}/comparisons/generate`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    generateManualComparison: async (id: string, itemASlug: string, itemBSlug: string) => {
        return serverMutation<ComparisonResult>({
            endpoint: `/works/${id}/comparisons/generate-manual`,
            data: { itemASlug, itemBSlug },
            method: 'POST',
            wrapInData: false,
        });
    },

    deleteComparison: async (id: string, slug: string) => {
        return serverMutation<ComparisonResult>({
            endpoint: `/works/${id}/comparisons/${slug}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
