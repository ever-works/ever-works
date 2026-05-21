import { Work } from '@ever-works/cli-shared';
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
    WorkPluginListResponse,
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
    WorkPluginListResponse,
};
export { GenerationMethod, WebsiteRepositoryCreationMethod };

// Types for API responses

export interface WorkConfig {
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

export interface CreateWorkDto {
    slug: string;
    name: string;
    description: string;
    owner?: string;
    readmeConfig?: MarkdownReadmeConfigDto;
    organization: boolean;
    gitProvider?: string;
    deployProvider?: string;
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

export interface PatchWorkDto {
    deployProvider?: string;
}

export interface LookupDeploymentResponse {
    status: 'success' | 'error';
    website?: string;
    deploymentState?: string;
    found: boolean;
    message?: string;
}

export interface DeleteWorkDto {
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

export interface WorksResponse {
    status: string;
    works: Work[];
    total: number;
    limit: number;
    offset: number;
}

export interface DeleteWorkResponse {
    status: 'success' | 'error' | 'pending';
    slug: string;
    message: string;
    deleted_repositories?: string[];
}

export interface DeployWebsiteResponse {
    status: 'success' | 'error' | 'pending';
    deploymentId?: string;
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

export interface DeployProviderInfo {
    id: string;
    name: string;
    enabled: boolean;
    description?: string;
}

export interface DeployProviderListResponse {
    status: string;
    providers: DeployProviderInfo[];
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
 * Centralized API service for all work-related operations
 */
export class ApiService {
    private httpClient = getHttpClient();

    // Work operations
    async getWorks(options?: { limit?: number; offset?: number }): Promise<WorksResponse> {
        const queryParams = new URLSearchParams();
        if (options?.limit) queryParams.append('limit', options.limit.toString());
        if (options?.offset) queryParams.append('offset', options.offset.toString());

        const response = await this.httpClient.get<WorksResponse>(
            `/works?${queryParams.toString()}`,
        );
        return response.data;
    }

    async createWork(data: CreateWorkDto) {
        const response = await this.httpClient.post<ApiResponse<{ work: Work }>>('/works', data);
        return response.data;
    }

    async getWork(id: string) {
        const response = await this.httpClient.get<ApiResponse<{ work: Work }>>(`/works/${id}`);
        return response.data;
    }

    async patchWork(workId: string, data: PatchWorkDto) {
        const response = await this.httpClient.put<ApiResponse<{ work: Work }>>(
            `/works/${workId}`,
            data,
        );
        return response.data;
    }

    async getWorkConfig(workId: string): Promise<WorkConfig | null> {
        try {
            const response = await this.httpClient.get<ApiResponse<{ config: WorkConfig }>>(
                `/works/${workId}/config`,
            );
            return response.data.config;
        } catch {
            return null;
        }
    }

    async generateContent(workId: string, data: CreateItemsGeneratorDto) {
        const response = await this.httpClient.post<ApiResponse<{ slug: string; message: string }>>(
            `/works/${workId}/generate`,
            data,
        );
        return response.data;
    }

    async updateWork(workId: string, data: UpdateItemsGeneratorDto) {
        const response = await this.httpClient.post<ApiResponse<{ slug: string; message: string }>>(
            `/works/${workId}/update`,
            data,
        );
        return response.data;
    }

    async submitItem(workId: string, data: SubmitItemDto) {
        const response = await this.httpClient.post<ApiResponse<ItemResponse>>(
            `/works/${workId}/submit-item`,
            data,
        );

        return response.data;
    }

    async removeItem(workId: string, data: RemoveItemDto) {
        const response = await this.httpClient.post<ApiResponse<ItemResponse>>(
            `/works/${workId}/remove-item`,
            data,
        );

        return response.data;
    }

    async regenerateMarkdown(workId: string) {
        const response = await this.httpClient.post<ApiResponse<{ message?: string }>>(
            `/works/${workId}/regenerate-markdown`,
        );

        return response.data;
    }

    async updateWebsite(workId: string) {
        const response = await this.httpClient.post<ApiResponse<UpdateWebsiteRepositoryResponse>>(
            `/works/${workId}/update-website`,
        );
        return response.data;
    }

    async deployWebsite(workId: string, data: DeployDto = {}) {
        const response = await this.httpClient.post<ApiResponse<DeployWebsiteResponse>>(
            `/deploy/works/${workId}`,
            data,
        );
        return response.data;
    }

    async deleteWork(id: string, data?: DeleteWorkDto) {
        const response = await this.httpClient.post<ApiResponse<DeleteWorkResponse>>(
            `/works/${id}/delete`,
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

    // Deploy provider operations (plugin-based)

    async getDeployProviders(): Promise<DeployProviderListResponse> {
        const response = await this.httpClient.get<DeployProviderListResponse>('/deploy/providers');
        return response.data;
    }

    // Deploy operations (work-scoped)

    async lookupExistingDeployment(workId: string): Promise<LookupDeploymentResponse> {
        const response = await this.httpClient.post<LookupDeploymentResponse>(
            `/deploy/works/${workId}/lookup`,
            {},
        );
        return response.data;
    }

    async checkDeployCapability(workId: string): Promise<DeployCapabilityResponse> {
        const response = await this.httpClient.post<DeployCapabilityResponse>(
            `/deploy/works/${workId}/check`,
        );
        return response.data;
    }

    async getDeployTeamsForWork(workId: string): Promise<DeploymentTeamResponse> {
        const response = await this.httpClient.post<DeploymentTeamResponse>(
            `/deploy/works/${workId}/teams`,
            {},
        );
        return response.data;
    }

    // Generator form schema

    async getGeneratorFormSchema(
        workId: string,
        pipelineId?: string,
    ): Promise<GeneratorFormSchema> {
        const queryParams = new URLSearchParams();
        if (pipelineId) queryParams.append('pipelineId', pipelineId);

        const query = queryParams.toString();
        const url = `/works/${workId}/generator-form${query ? `?${query}` : ''}`;

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
            autoEnableForWorks?: boolean;
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

    // Plugin operations (work-level)

    async getWorkPlugins(workId: string): Promise<WorkPluginListResponse> {
        const response = await this.httpClient.get<WorkPluginListResponse>(
            `/works/${workId}/plugins`,
        );
        return response.data;
    }

    async enableWorkPlugin(
        workId: string,
        pluginId: string,
        data?: {
            settings?: Record<string, unknown>;
            activeCapability?: string;
            priority?: number;
        },
    ): Promise<void> {
        await this.httpClient.post(`/works/${workId}/plugins/${pluginId}/enable`, data || {});
    }

    async disableWorkPlugin(workId: string, pluginId: string): Promise<void> {
        await this.httpClient.post(`/works/${workId}/plugins/${pluginId}/disable`, {});
    }

    async updateWorkPluginSettings(
        workId: string,
        pluginId: string,
        data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
        },
    ): Promise<void> {
        await this.httpClient.patch(`/works/${workId}/plugins/${pluginId}/settings`, data);
    }

    async setWorkPluginCapability(
        workId: string,
        pluginId: string,
        capability: string,
    ): Promise<void> {
        await this.httpClient.post(`/works/${workId}/plugins/${pluginId}/capability`, {
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
