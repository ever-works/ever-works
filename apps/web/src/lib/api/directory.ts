import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { GenerateStatusType, GenerationMethod, ItemsGeneratorStep, RepoProvider } from './enums';
import { APIResponse, ItemData } from './types';
import { CreateItemsGeneratorDto } from './items-generator';

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
}

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

    // Generate directory details from name and prompt
    generateDetails: async (data: GenerateDirectoryDetailDto) => {
        return serverMutation<DirectoryDetails>({
            endpoint: '/directories/generate-details',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },
};
