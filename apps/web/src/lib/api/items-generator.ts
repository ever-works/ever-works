import { serverMutation } from './server-api';

// Enums
export enum GenerationMethod {
    CREATE_UPDATE = 'create-update',
    RECREATE = 'recreate',
}

export enum WebsiteRepositoryCreationMethod {
    DUPLICATE = 'duplicate',
    FORK = 'fork',
    CREATE_USING_TEMPLATE = 'create-using-template',
}

// DTOs
export interface CompanyDto {
    name: string;
    website: string;
}

export interface ConfigDto {
    max_search_queries?: number;
    max_results_per_query?: number;
    max_pages_to_process?: number;
    relevance_threshold_content?: number;
    min_content_length_for_extraction?: number;
    ai_first_generation_enabled?: boolean;
    content_filtering_enabled?: boolean;
    prompt_comparison_confidence_threshold?: number;
}

export interface CreateItemsGeneratorDto {
    slug: string;
    name: string;
    prompt: string;
    company?: CompanyDto;
    initial_categories?: string[];
    priority_categories?: string[];
    target_keywords?: string[];
    source_urls?: string[];
    config?: ConfigDto;
    repository_description?: string;
    generation_method?: GenerationMethod;
    update_with_pull_request?: boolean;
    badge_evaluation_enabled?: boolean;
    website_repository_creation_method?: WebsiteRepositoryCreationMethod;
}

export interface UpdateItemsGeneratorDto {
    generation_method?: GenerationMethod;
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

export interface ExtractItemDetailsDto {
    url: string;
}

// Response Types
export interface ItemsGeneratorResponse {
    id: string;
    slug: string;
    status: string;
    message?: string;
}

export interface SubmitItemResponse {
    success: boolean;
    message: string;
    item?: {
        id: string;
        name: string;
        slug: string;
        category: string;
    };
}

export interface RemoveItemResponse {
    success: boolean;
    message: string;
}

export interface ExtractItemDetailsResponse {
    title?: string;
    description?: string;
    keywords?: string[];
    tags?: string[];
    error?: string;
}

export interface RegenerateMarkdownResponse {
    status: string;
    error_details?: string;
}

export const itemsGeneratorAPI = {
    // Generate items
    generate: async (data: CreateItemsGeneratorDto) => {
        return serverMutation<ItemsGeneratorResponse>({
            endpoint: '/generate',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Update items generator
    update: async (slug: string, data: UpdateItemsGeneratorDto) => {
        return serverMutation<ItemsGeneratorResponse>({
            endpoint: `/update/${slug}`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Submit new item
    submitItem: async (slug: string, data: SubmitItemDto) => {
        return serverMutation<SubmitItemResponse>({
            endpoint: `/submit-item/${slug}`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Remove item
    removeItem: async (slug: string, data: RemoveItemDto) => {
        return serverMutation<RemoveItemResponse>({
            endpoint: `/remove-item/${slug}`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Extract item details from URL
    extractItemDetails: async (data: ExtractItemDetailsDto) => {
        return serverMutation<ExtractItemDetailsResponse>({
            endpoint: '/extract-item-details',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Regenerate markdown
    regenerateMarkdown: async (slug: string) => {
        return serverMutation<RegenerateMarkdownResponse>({
            endpoint: `/regenerate-markdown/${slug}`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
