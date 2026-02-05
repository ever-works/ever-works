import { Directory } from '@packages/cli-shared';
import { getHttpClient } from './http-client';

// Types for API responses

export interface MarkdownReadmeConfigDto {
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
    readmeConfig?: MarkdownReadmeConfigDto;
    organization: boolean;
}

export interface CreateItemsGeneratorDto {
    name: string;
    prompt: string;
    company?: {
        name: string;
        website: string;
    };
    initial_categories?: string[];
    priority_categories?: string[];
    target_keywords?: string[];
    source_urls?: string[];
    generation_method?: 'create-update' | 'recreate';
    website_repository_creation_method?: 'duplicate' | 'create-using-template';
    repository_description?: string;
    update_with_pull_request?: boolean;
    badge_evaluation_enabled?: boolean;
    config?: {
        max_search_queries?: number;
        max_results_per_query?: number;
        max_pages_to_process?: number;
        relevance_threshold_content?: number;
        min_content_length_for_extraction?: number;
        ai_first_generation_enabled?: boolean;
        content_filtering_enabled?: boolean;
        prompt_comparison_confidence_threshold?: number;
    };
}

export interface UpdateDirectoryDto {
    generation_method?: 'create-update' | 'recreate';
    update_with_pull_request?: boolean;
}

export interface ItemResponse {
    status: 'success' | 'error' | 'pending';
    slug: string;
    item_name: string;
    message: string;
    pr_number?: number;
    pr_url?: string;
    pr_title?: string;
    pr_body?: string;
    pr_branch_name?: string;
    auto_merged?: boolean;
}

export type ApiResponse<T> = {
    status: 'success' | 'error' | 'pending';
} & T;

export interface SubmitItemDto {
    name: string;
    description: string;
    source_url: string;
    category: string;
    tags?: string[];
    featured?: boolean;
    pay_and_publish_now?: boolean;
    slug?: string;
    create_pull_request?: boolean;
}

export interface UpdateWebsiteRepositoryResponse {
    status: 'success' | 'error';
    slug: string;
    owner: string;
    repository: string;
    message: string;
    method_used?: string;
}

export interface RemoveItemDto {
    item_slug: string;
    reason?: string;
    create_pull_request?: boolean;
}

export interface DeployDto {
    DEPLOY_TOKEN?: string;
    GITHUB_TOKEN?: string;
    teamScope?: string;
}

export interface DeleteDirectoryDto {
    reason?: string;
    force_delete?: boolean;
    delete_data_repository?: boolean;
    delete_markdown_repository?: boolean;
    delete_website_repository?: boolean;
}

export interface UserProfile {
    id: string;
    username: string;
    email: string;
    avatar?: string;
}

export interface DirectoriesResponse {
    status: string;
    directories: Directory[];
    total: number;
    limit: number;
    offset: number;
}

export interface DeleteDirectoryResponse {
    status: 'success' | 'error' | 'pending';
    slug: string;
    message: string;
    deleted_repositories?: string[];
}

export interface DeployWebsiteResponse {
    status: 'success' | 'error' | 'pending';
    slug: string;
    owner: string;
    repository: string;
    message: string;
    deployment_url?: string;
}

export interface DeploymentTeam {
    id: string;
    slug: string;
    name: string | null;
    createdAt: number;
}

export interface DeploymentTeamResponse extends ApiResponse<{ teams: DeploymentTeam[] }> {}

export interface ConnectionInfo {
    provider: string;
    connected: boolean;
    email?: string;
    username?: string;
    scopes?: string[];
    connectedAt?: Date;
    metadata?: Record<string, any>;
}

export interface GitHubOrganization {
    login: string;
    id: number;
    node_id: string;
    url: string;
    repos_url: string;
    events_url: string;
    hooks_url: string;
    issues_url: string;
    members_url: string;
    public_members_url: string;
    avatar_url: string;
    description: string;
}

/**
 * Centralized API service for all directory-related operations
 */
export class ApiService {
    private httpClient = getHttpClient();

    // Directory operations
    async getDirectories(options?: {
        limit?: number;
        offset?: number;
    }): Promise<DirectoriesResponse> {
        const queryParams = new URLSearchParams();
        if (options?.limit) queryParams.append('limit', options.limit.toString());
        if (options?.offset) queryParams.append('offset', options.offset.toString());

        const response = await this.httpClient.get<DirectoriesResponse>(
            `/directories?${queryParams.toString()}`,
        );
        return response.data;
    }

    async createDirectory(data: CreateDirectoryDto) {
        const response = await this.httpClient.post<ApiResponse<{ directory: Directory }>>(
            '/directories',
            data,
        );
        return response.data;
    }

    async getDirectory(id: string) {
        const response = await this.httpClient.get<ApiResponse<{ directory: Directory }>>(
            `/directories/${id}`,
        );
        return response.data;
    }

    async generateContent(directoryId: string, data: CreateItemsGeneratorDto) {
        const response = await this.httpClient.post<ApiResponse<{ slug: string; message: string }>>(
            `/directories/${directoryId}/generate`,
            data,
        );
        return response.data;
    }

    async updateDirectory(directoryId: string, data: UpdateDirectoryDto) {
        const response = await this.httpClient.post<ApiResponse<{ slug: string; message: string }>>(
            `/directories/${directoryId}/update`,
            data,
        );
        return response.data;
    }

    async submitItem(directoryId: string, data: SubmitItemDto) {
        const response = await this.httpClient.post<ApiResponse<ItemResponse>>(
            `/directories/${directoryId}/submit-item`,
            data,
        );

        return response.data;
    }

    async removeItem(directoryId: string, data: RemoveItemDto) {
        const response = await this.httpClient.post<ApiResponse<ItemResponse>>(
            `/directories/${directoryId}/remove-item`,
            data,
        );

        return response.data;
    }

    async regenerateMarkdown(directoryId: string) {
        const response = await this.httpClient.post<ApiResponse<{ message?: string }>>(
            `/directories/${directoryId}/regenerate-markdown`,
        );

        return response.data;
    }

    async updateWebsite(directoryId: string) {
        const response = await this.httpClient.post<ApiResponse<UpdateWebsiteRepositoryResponse>>(
            `/directories/${directoryId}/update-website`,
        );
        return response.data;
    }

    async deployWebsite(directoryId: string, data: DeployDto = {}) {
        const response = await this.httpClient.post<ApiResponse<DeployWebsiteResponse>>(
            `/deploy/directories/${directoryId}`,
            data,
        );
        return response.data;
    }

    async getDeploymentTeams() {
        const response = await this.httpClient.post<DeploymentTeamResponse>('/deploy/teams', {});
        return response.data;
    }

    async deleteDirectory(id: string, data?: DeleteDirectoryDto) {
        const response = await this.httpClient.post<ApiResponse<DeleteDirectoryResponse>>(
            `/directories/${id}/delete`,
            data,
        );
        return response.data;
    }

    // OAuth operations

    async getProfile(): Promise<UserProfile> {
        const response = await this.httpClient.get<UserProfile>('/auth/profile/fresh');
        return response.data;
    }

    async checkConnection(provider: string): Promise<ConnectionInfo> {
        const response = await this.httpClient.get<ConnectionInfo>(`/auth/connections/${provider}`);
        return response.data;
    }

    async getGitHubOrgs(): Promise<GitHubOrganization[]> {
        const response = await this.httpClient.get<GitHubOrganization[]>(
            '/auth/connections/github/orgs',
        );
        return response.data;
    }
}

// Singleton instance
let apiServiceInstance: ApiService | null = null;

export function getApiService(): ApiService {
    if (!apiServiceInstance) {
        apiServiceInstance = new ApiService();
    }
    return apiServiceInstance;
}
