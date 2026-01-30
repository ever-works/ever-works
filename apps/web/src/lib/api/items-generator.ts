import 'server-only';
import { serverMutation, serverFetch } from './server-api';
import { GenerationMethod, WebsiteRepositoryCreationMethod } from './enums';
import { APIResponse, ItemData } from './types';
import type { GeneratorFormSchema } from '@ever-works/plugin';

// Re-export types from @ever-works/plugin for use in the web app
export type {
    PluginIcon,
    ProviderOption,
    GeneratorFormSchema,
    FormSchemaProvidersType,
    ProviderSelectionState,
    SelectableProviderCategory,
    ProviderCategoryKey,
} from '@ever-works/plugin';

export type { FormFieldDefinition, FormFieldGroup } from '@ever-works/contracts';

// DTOs
export interface CompanyDto {
    name: string;
    website: string;
}

/** Provider selection for each capability category. */
export interface ProvidersDto {
    search?: string;
    screenshot?: string;
    ai?: string;
    contentExtractor?: string;
    pipeline?: string;
}

/**
 * Minimal core DTO for creating/triggering item generation.
 * All pipeline-specific configuration is passed via pluginConfig.
 */
export interface CreateItemsGeneratorDto {
    name: string;
    prompt: string;
    company?: CompanyDto;
    repository_description?: string;
    generation_method?: GenerationMethod;
    update_with_pull_request?: boolean;
    website_repository_creation_method?: WebsiteRepositoryCreationMethod;
    providers?: ProvidersDto;
    /** Plugin-specific configuration - structure defined by selected pipeline plugin */
    pluginConfig?: Record<string, unknown>;
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
    categories?: string[];
    tags?: string[];
    featured?: boolean;
    order?: number;
    pay_and_publish_now?: boolean;
    slug?: string;
    brand?: string;
    brand_logo_url?: string;
    images?: string[];
    create_pull_request?: boolean;
}

export interface RemoveItemDto {
    item_slug: string;
    reason?: string;
    create_pull_request?: boolean;
}

export interface UpdateItemDto {
    item_slug: string;
    featured?: boolean;
    order?: number;
    create_pull_request?: boolean;
}

export interface ExtractItemDetailsDto {
    source_url: string;
    existing_categories?: string[];
}

// Response Types
export interface ItemsGeneratorResponse {
    id: string;
    slug: string;
    status: string;
    message?: string;
}

export interface ItemResponse {
    status: 'success' | 'error' | 'pending';
    slug: string;
    item_name: string;
    item_slug?: string;
    message: string;
    pr_number?: number;
    pr_url?: string;
    pr_title?: string;
    pr_body?: string;
    pr_branch_name?: string;
    auto_merged?: boolean;
    /** The created/updated item data (available on success) */
    item?: ItemData;
}

export interface ExtractItemDetailsResponse {
    status: 'success' | 'error';
    source_url: string;
    message: string;
    item?: ItemData;
}

export interface RegenerateMarkdownResponse {
    status: string;
    message?: string;
}

export const itemsGeneratorAPI = {
    // Generate items
    generate: async (directoryId: string, data: CreateItemsGeneratorDto) => {
        return serverMutation<ItemsGeneratorResponse>({
            endpoint: `/directories/${directoryId}/generate`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Update items generator
    update: async (directoryId: string, data: UpdateItemsGeneratorDto) => {
        return serverMutation<ItemsGeneratorResponse>({
            endpoint: `/directories/${directoryId}/update`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Submit new item
    submitItem: async (directoryId: string, data: SubmitItemDto) => {
        return serverMutation<ItemResponse>({
            endpoint: `/directories/${directoryId}/submit-item`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Remove item
    removeItem: async (directoryId: string, data: RemoveItemDto) => {
        return serverMutation<ItemResponse>({
            endpoint: `/directories/${directoryId}/remove-item`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Update item metadata
    updateItem: async (directoryId: string, data: UpdateItemDto) => {
        return serverMutation<ItemResponse>({
            endpoint: `/directories/${directoryId}/update-item`,
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
    regenerateMarkdown: async (directoryId: string) => {
        return serverMutation<APIResponse<{ message?: string }>>({
            endpoint: `/directories/${directoryId}/regenerate-markdown`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Get generator form schema
    getFormSchema: async (directoryId: string, pipelineId?: string) => {
        const queryParams = pipelineId ? `?pipelineId=${encodeURIComponent(pipelineId)}` : '';
        return serverFetch<GeneratorFormSchema>(
            `/directories/${directoryId}/generator-form${queryParams}`,
        );
    },
};
