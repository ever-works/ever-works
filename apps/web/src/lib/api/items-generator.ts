import 'server-only';
import { serverMutation, serverFetch } from './server-api';
import { APIResponse, ItemData } from './types';
import type { GeneratorFormSchema } from '@ever-works/plugin';
import type {
    ProvidersDto,
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    SubmitItemDto,
    RemoveItemDto,
    UpdateItemDto,
    CheckItemHealthDto,
    CheckItemHealthResponseDto,
    ExtractItemDetailsDto,
} from '@ever-works/contracts/api';

// Re-export types from @ever-works/plugin for use in the web app
export type {
    PluginIcon,
    ProviderOption,
    ProviderModelSummary,
    GeneratorFormSchema,
    FormSchemaProvidersType,
    ProviderSelectionState,
    SelectableProviderCategory,
    ProviderCategoryKey,
} from '@ever-works/plugin';

export type { FormFieldDefinition, FormFieldGroup } from '@ever-works/contracts';

// Re-export DTOs from centralized contracts package
export type {
    ProvidersDto,
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    SubmitItemDto,
    RemoveItemDto,
    UpdateItemDto,
    CheckItemHealthDto,
    CheckItemHealthResponseDto,
    ExtractItemDetailsDto,
};

// Response Types
export interface ItemsGeneratorResponse {
    id: string;
    slug: string;
    status: 'success' | 'error' | 'pending' | 'skipped';
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

export interface CancelGenerationResponse {
    status: 'success';
    message: string;
    mode: 'trigger' | 'in_process' | 'stale' | 'already_finished';
}

export const itemsGeneratorAPI = {
    // Generate items
    generate: async (workId: string, data: CreateItemsGeneratorDto) => {
        return serverMutation<ItemsGeneratorResponse>({
            endpoint: `/works/${workId}/generate`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Update items generator
    update: async (workId: string, data: UpdateItemsGeneratorDto) => {
        return serverMutation<ItemsGeneratorResponse>({
            endpoint: `/works/${workId}/update`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    cancel: async (workId: string) => {
        return serverMutation<CancelGenerationResponse>({
            endpoint: `/works/${workId}/cancel-generation`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Submit new item
    submitItem: async (workId: string, data: SubmitItemDto) => {
        return serverMutation<ItemResponse>({
            endpoint: `/works/${workId}/submit-item`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Remove item
    removeItem: async (workId: string, data: RemoveItemDto) => {
        return serverMutation<ItemResponse>({
            endpoint: `/works/${workId}/remove-item`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Update item metadata
    updateItem: async (workId: string, data: UpdateItemDto) => {
        return serverMutation<ItemResponse>({
            endpoint: `/works/${workId}/update-item`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    checkItemHealth: async (workId: string, data: CheckItemHealthDto) => {
        return serverMutation<CheckItemHealthResponseDto>({
            endpoint: `/works/${workId}/check-item-health`,
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
    regenerateMarkdown: async (workId: string) => {
        return serverMutation<APIResponse<{ message?: string }>>({
            endpoint: `/works/${workId}/regenerate-markdown`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Get generator form schema
    getFormSchema: async (workId: string, pipelineId?: string) => {
        const queryParams = pipelineId ? `?pipelineId=${encodeURIComponent(pipelineId)}` : '';
        return serverFetch<GeneratorFormSchema>(
            `/works/${workId}/generator-form${queryParams}`,
        );
    },

    // Get global generator form schema (no work context)
    getFormSchemaGlobal: async (pipelineId?: string) => {
        const queryParams = pipelineId ? `?pipelineId=${encodeURIComponent(pipelineId)}` : '';
        return serverFetch<GeneratorFormSchema>(`/generator-form${queryParams}`);
    },
};
