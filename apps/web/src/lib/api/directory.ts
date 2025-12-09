import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import {
    GenerateStatusType,
    GenerationMethod,
    ItemsGeneratorStep,
    RepoProvider,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    DirectoryScheduleBillingMode,
} from './enums';
import { APIResponse, ItemData } from './types';
import { CreateItemsGeneratorDto, ItemsGeneratorResponse } from './items-generator';

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
    repoProvider?: RepoProvider;
    readmeConfig?: MarkdownReadmeConfig;
}

export interface UpdateDirectoryDto {
    name?: string;
    description?: string;
    owner?: string;
    organization?: boolean;
    readmeConfig?: MarkdownReadmeConfig;
}

export interface DeleteDirectoryDto {
    delete_data_repository?: boolean;
    delete_markdown_repository?: boolean;
    delete_website_repository?: boolean;
}

export interface GenerateDirectoryDetailDto {
    directory_name: string;
    prompt: string;
}

export type GenerateStatus = {
    status: GenerateStatusType;
    step?: ItemsGeneratorStep;
    error?: string;
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
    repoProvider: RepoProvider;
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
}

export interface DirectoryScheduleAllowedCadence {
    cadence: DirectoryScheduleCadence;
    reason?: string;
    payPerUse?: boolean;
    allowed: boolean;
}

export interface DirectoryScheduleDto {
    status: DirectoryScheduleStatus;
    cadence: DirectoryScheduleCadence | null;
    billingMode: DirectoryScheduleBillingMode;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: GenerateStatusType | null;
    failureCount: number;
    maxFailureBeforePause: number;
    allowedCadences: DirectoryScheduleAllowedCadence[];
    planCode?: string;
    subscriptionsEnabled: boolean;
}

export type UpdateDirectorySchedulePayload = {
    enable?: boolean;
    cadence?: DirectoryScheduleCadence;
    billingMode?: DirectoryScheduleBillingMode;
    maxFailureBeforePause?: number;
};

export interface DirectoriesResponse {
    directories: Directory[];
    total: number;
    limit?: number;
    offset?: number;
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
    } & (Record<string, any> & {});
}

export interface DirectoryCount {
    items: number;
    categories: number;
    tags: number;
}

export interface DirectoryCategoriesTags {
    categories: string[];
    tags: string[];
}

export interface GenerationMetrics {
    urls_scanned?: number;
    pages_processed?: number;
    items_extracted_current_run?: number;
    new_items_added_to_store?: number;
    total_items_in_store?: number;
    total_tokens_used?: number;
    total_cost?: number;
}

export interface DirectoryGenerationHistoryEntry {
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
    parameters?: CreateItemsGeneratorDto | null;
    createdAt: string;
    updatedAt: string;
}

export interface DirectoryGenerationHistoryResponse {
    history: DirectoryGenerationHistoryEntry[];
    total: number;
    limit: number;
    offset: number;
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
    getHistory: async (id: string, options?: { limit?: number; offset?: number }) => {
        const params = new URLSearchParams();
        if (options?.limit !== undefined) params.append('limit', String(options.limit));
        if (options?.offset !== undefined) params.append('offset', String(options.offset));
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
};
