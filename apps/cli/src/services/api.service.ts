import { getHttpClient } from './http-client';

// Types for API responses
export interface Directory {
    id: number;
    name: string;
    slug: string;
    website?: string;
    owner: string;
    companyName?: string;
    organization: boolean;
    description: string;
    readmeConfig?: MarkdownReadmeConfigDto;
}

export interface MarkdownReadmeConfigDto {
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
    readme_config?: MarkdownReadmeConfigDto;
}

export interface CreateItemsGeneratorDto {
    slug: string;
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
    website_repository_creation_method?: 'duplicate' | 'fork' | 'create-using-template';
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

export interface SubmitItemDto {
    name: string;
    description: string;
    source_url: string;
    category: string;
    tags?: string[];
    featured?: boolean;
    pay_and_publish_now?: boolean;
    slug?: string;
}

export interface RemoveItemDto {
    item_slug: string;
    reason?: string;
}

export interface DeployDto {
    VERCEL_TOKEN?: string;
    GITHUB_TOKEN?: string;
}

export interface DeleteDirectoryDto {
    reason?: string;
    force_delete?: boolean;
    delete_data_repository?: boolean;
    delete_markdown_repository?: boolean;
    delete_website_repository?: boolean;
}

export interface DirectoriesResponse {
    status: string;
    directories: Directory[];
    total: number;
    limit: number;
    offset: number;
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

    async createDirectory(data: CreateDirectoryDto): Promise<{ directory: Directory }> {
        const response = await this.httpClient.post<{ directory: Directory }>('/directories', data);
        return response.data;
    }

    async getDirectory(id: string): Promise<Directory> {
        const response = await this.httpClient.get<Directory>(`/directories/${id}`);
        return response.data;
    }

    async generateContent(data: CreateItemsGeneratorDto): Promise<ApiResponse> {
        const response = await this.httpClient.post<ApiResponse>('/generate', data);
        return response.data;
    }

    async updateDirectory(slug: string, data: UpdateDirectoryDto): Promise<ApiResponse> {
        const response = await this.httpClient.post<ApiResponse>(`/update/${slug}`, data);
        return response.data;
    }

    async submitItem(slug: string, data: SubmitItemDto): Promise<ApiResponse> {
        const response = await this.httpClient.post<ApiResponse>(`/submit-item/${slug}`, data);
        return response.data;
    }

    async removeItem(slug: string, data: RemoveItemDto): Promise<ApiResponse> {
        const response = await this.httpClient.post<ApiResponse>(`/remove-item/${slug}`, data);
        return response.data;
    }

    async regenerateMarkdown(slug: string): Promise<ApiResponse> {
        const response = await this.httpClient.post<ApiResponse>(`/regenerate-markdown/${slug}`);
        return response.data;
    }

    async updateWebsite(slug: string): Promise<ApiResponse> {
        const response = await this.httpClient.post<ApiResponse>(`/update-website/${slug}`);
        return response.data;
    }

    async deployWebsite(slug: string, data?: DeployDto): Promise<ApiResponse> {
        const response = await this.httpClient.post<ApiResponse>(`/deploy/${slug}/vercel`, data);
        return response.data;
    }

    async deleteDirectory(id: string, data?: DeleteDirectoryDto): Promise<ApiResponse> {
        const response = await this.httpClient.post<ApiResponse>(`/directories/${id}/delete`, data);
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
