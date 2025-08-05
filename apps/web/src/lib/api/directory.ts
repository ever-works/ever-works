import { serverFetch, serverMutation } from './server-api';

// DTOs
export enum RepoProvider {
    GITHUB = 'github',
}

export interface MarkdownReadmeConfig {
    header?: string;
    overwrite_default_header?: boolean;
    footer?: string;
    overwrite_default_footer?: boolean;
}

export interface CreateDirectoryDto {
    slug: string;
    name: string;
    description: string;
    owner?: string;
    organization: boolean;
    repo_provider?: RepoProvider;
    readme_config?: MarkdownReadmeConfig;
}

export interface DeleteDirectoryDto {
    confirmation: boolean;
}

// Response Types
export interface DirectoryResponse {
    id: string;
    slug: string;
    name: string;
    description: string;
    owner?: string;
    organization: boolean;
    repo_provider: RepoProvider;
    readme_config?: MarkdownReadmeConfig;
    created_at: string;
    updated_at: string;
}

export interface DirectoriesResponse {
    directories: DirectoryResponse[];
    total: number;
    limit?: number;
    offset?: number;
}

export interface DeleteDirectoryResponse {
    success: boolean;
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

    // Create a new directory
    create: async (data: CreateDirectoryDto) => {
        return serverMutation<DirectoryResponse>({
            endpoint: '/directories',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Delete a directory
    delete: async (slug: string, data: DeleteDirectoryDto) => {
        return serverMutation<DeleteDirectoryResponse>({
            endpoint: `/directories/delete/${slug}`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },
};
