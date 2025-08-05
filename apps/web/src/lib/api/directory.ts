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
    // Get all directories with pagination
    getAll: async (limit?: number, offset?: number) => {
        const params = new URLSearchParams();
        if (limit !== undefined) params.append('limit', limit.toString());
        if (offset !== undefined) params.append('offset', offset.toString());
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
