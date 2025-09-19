import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { RepoProvider } from './enums';
import { ItemData } from './types';

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
    readmeConfig?: MarkdownReadmeConfig;
}

export interface DeleteDirectoryDto {
    confirmation: boolean;
}

export interface GenerateDirectoryDetailDto {
    directory_name: string;
    prompt: string;
}

export enum GenerateStatusType {
    GENERATING = 'generating',
    GENERATED = 'generated',
    ERROR = 'error',
}

export type GenerateStatus = {
    status: GenerateStatusType;
    step?: string;
    error?: string;
};

// Response Types
export interface Directory {
    id: string;
    slug: string;
    name: string;
    description: string;
    owner?: string;
    organization: boolean;
    repoProvider: RepoProvider;
    readmeConfig?: MarkdownReadmeConfig;
    generateStatus?: GenerateStatus;
    createdAt: string;
    updatedAt: string;
}

export interface DirectoriesResponse {
    directories: Directory[];
    total: number;
    limit?: number;
    offset?: number;
}

export interface DeleteDirectoryResponse {
    success: boolean;
    message: string;
}

export type APIResponse<T> = {
    status: 'success' | 'error';
} & T;

export interface DirectoryDetails {
    name: string;
    slug: string;
    description: string;
    keywords: string[];
    categories: string[];
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
        return serverMutation<Directory>({
            endpoint: '/directories',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Update a directory by ID
    update: async (id: string, data: UpdateDirectoryDto) => {
        return serverMutation<Directory>({
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
