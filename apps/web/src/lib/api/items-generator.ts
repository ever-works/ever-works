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

    cancel: async (directoryId: string) => {
        return serverMutation<CancelGenerationResponse>({
            endpoint: `/directories/${directoryId}/cancel-generation`,
            data: {},
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

    checkItemHealth: async (directoryId: string, data: CheckItemHealthDto) => {
        return serverMutation<CheckItemHealthResponseDto>({
            endpoint: `/directories/${directoryId}/check-item-health`,
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

    // Get global generator form schema (no directory context)
    getFormSchemaGlobal: async (pipelineId?: string) => {
        const queryParams = pipelineId ? `?pipelineId=${encodeURIComponent(pipelineId)}` : '';
        return serverFetch<GeneratorFormSchema>(`/generator-form${queryParams}`);
    },
};
