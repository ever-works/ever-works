import { Directory } from '@ever-works/cli-shared';
import { getHttpClient } from './http-client';
import type {
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    ProvidersDto,
} from '@ever-works/contracts/api';
import { GenerationMethod, WebsiteRepositoryCreationMethod } from '@ever-works/contracts/api';
import type {
    GeneratorFormSchema,
    ProviderOption,
    GitProviderInfo,
    GitOrganization,
    FormFieldDefinition,
    FormFieldGroup,
    AiModel,
} from '@ever-works/plugin';
import type {
    PluginListResponse,
    UserPluginResponse,
    DirectoryPluginListResponse,
} from '@ever-works/plugin/api';

// Re-export types used by other CLI modules
export type {
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    ProvidersDto,
    GeneratorFormSchema,
    ProviderOption,
    GitProviderInfo,
    GitOrganization,
    FormFieldDefinition,
    FormFieldGroup,
    AiModel,
    PluginListResponse,
    UserPluginResponse,
    DirectoryPluginListResponse,
};
export { GenerationMethod, WebsiteRepositoryCreationMethod };

// Types for API responses

export interface DirectoryConfig {
    metadata?: {
        initial_prompt?: string;
        last_request_data?: CreateItemsGeneratorDto;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

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

export interface GitProviderConnectionInfo extends GitProviderInfo {
    connected: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
    authMethod?: string;
}

export interface GitProviderListResponse {
    configured: boolean;
    providers: GitProviderInfo[];
}

export interface GitOrganizationsResponse {
    success: boolean;
    organizations: GitOrganization[];
    error?: string;
}

export interface DeployCapabilityResponse {
    status: 'success' | 'error';
    canDeploy: boolean;
    isShared: boolean;
    ownerHasToken: boolean;
    userHasToken: boolean;
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

    async getDirectoryConfig(directoryId: string): Promise<DirectoryConfig | null> {
        try {
            const response = await this.httpClient.get<ApiResponse<{ config: DirectoryConfig }>>(
                `/directories/${directoryId}/config`,
            );
            return response.data.config;
        } catch {
            return null;
        }
    }

    async generateContent(directoryId: string, data: CreateItemsGeneratorDto) {
        const response = await this.httpClient.post<ApiResponse<{ slug: string; message: string }>>(
            `/directories/${directoryId}/generate`,
            data,
        );
        return response.data;
    }

    async updateDirectory(directoryId: string, data: UpdateItemsGeneratorDto) {
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

    // Git provider operations (plugin-based)

    async getGitProviders(): Promise<GitProviderListResponse> {
        const response = await this.httpClient.get<GitProviderListResponse>('/git-providers');
        return response.data;
    }

    async checkGitProviderConnection(providerId: string): Promise<GitProviderConnectionInfo> {
        const response = await this.httpClient.get<GitProviderConnectionInfo>(
            `/git-providers/${providerId}/connection`,
        );
        return response.data;
    }

    async getGitProviderOrganizations(providerId: string): Promise<GitOrganizationsResponse> {
        const response = await this.httpClient.get<GitOrganizationsResponse>(
            `/git-providers/${providerId}/organizations`,
        );
        return response.data;
    }

    // Deploy operations (directory-scoped)

    async checkDeployCapability(directoryId: string): Promise<DeployCapabilityResponse> {
        const response = await this.httpClient.post<DeployCapabilityResponse>(
            `/deploy/directories/${directoryId}/check`,
        );
        return response.data;
    }

    async getDeployTeamsForDirectory(directoryId: string): Promise<DeploymentTeamResponse> {
        const response = await this.httpClient.post<DeploymentTeamResponse>(
            `/deploy/directories/${directoryId}/teams`,
            {},
        );
        return response.data;
    }

    // Generator form schema

    async getGeneratorFormSchema(
        directoryId: string,
        pipelineId?: string,
    ): Promise<GeneratorFormSchema> {
        const queryParams = new URLSearchParams();
        if (pipelineId) queryParams.append('pipelineId', pipelineId);

        const query = queryParams.toString();
        const url = `/directories/${directoryId}/generator-form${query ? `?${query}` : ''}`;

        const response = await this.httpClient.get<GeneratorFormSchema>(url);
        return response.data;
    }

    // Plugin operations (user-level)

    async getPlugins(options?: { category?: string }): Promise<PluginListResponse> {
        const queryParams = new URLSearchParams();
        if (options?.category) queryParams.append('category', options.category);
        const query = queryParams.toString();
        const response = await this.httpClient.get<PluginListResponse>(
            `/plugins${query ? `?${query}` : ''}`,
        );
        return response.data;
    }

    async getPlugin(pluginId: string): Promise<UserPluginResponse> {
        const response = await this.httpClient.get<UserPluginResponse>(`/plugins/${pluginId}`);
        return response.data;
    }

    async listPluginModels(pluginId: string): Promise<readonly AiModel[]> {
        try {
            const response = await this.httpClient.get<readonly AiModel[]>(
                `/plugins/${pluginId}/models`,
            );
            return response.data;
        } catch {
            return [];
        }
    }

    async enablePlugin(
        pluginId: string,
        data?: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
            autoEnableForDirectories?: boolean;
        },
    ): Promise<UserPluginResponse> {
        const response = await this.httpClient.post<UserPluginResponse>(
            `/plugins/${pluginId}/enable`,
            data || {},
        );
        return response.data;
    }

    async disablePlugin(pluginId: string): Promise<UserPluginResponse> {
        const response = await this.httpClient.post<UserPluginResponse>(
            `/plugins/${pluginId}/disable`,
            {},
        );
        return response.data;
    }

    async updatePluginSettings(
        pluginId: string,
        data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
        },
    ): Promise<UserPluginResponse> {
        const response = await this.httpClient.patch<UserPluginResponse>(
            `/plugins/${pluginId}/settings`,
            data,
        );
        return response.data;
    }

    // Plugin operations (directory-level)

    async getDirectoryPlugins(directoryId: string): Promise<DirectoryPluginListResponse> {
        const response = await this.httpClient.get<DirectoryPluginListResponse>(
            `/directories/${directoryId}/plugins`,
        );
        return response.data;
    }

    async enableDirectoryPlugin(
        directoryId: string,
        pluginId: string,
        data?: {
            settings?: Record<string, unknown>;
            activeCapability?: string;
            priority?: number;
        },
    ): Promise<void> {
        await this.httpClient.post(
            `/directories/${directoryId}/plugins/${pluginId}/enable`,
            data || {},
        );
    }

    async disableDirectoryPlugin(directoryId: string, pluginId: string): Promise<void> {
        await this.httpClient.post(`/directories/${directoryId}/plugins/${pluginId}/disable`, {});
    }

    async updateDirectoryPluginSettings(
        directoryId: string,
        pluginId: string,
        data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
        },
    ): Promise<void> {
        await this.httpClient.patch(
            `/directories/${directoryId}/plugins/${pluginId}/settings`,
            data,
        );
    }

    async setDirectoryPluginCapability(
        directoryId: string,
        pluginId: string,
        capability: string,
    ): Promise<void> {
        await this.httpClient.post(`/directories/${directoryId}/plugins/${pluginId}/capability`, {
            capability,
        });
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
