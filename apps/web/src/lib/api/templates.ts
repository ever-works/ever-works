import 'server-only';
import type { PluginIcon } from '@ever-works/plugin';
import { serverFetch, serverMutation } from './server-api';
import { APIResponse } from './types';

export type TemplateKind = 'website' | 'work';
export type TemplateSourceType = 'built_in' | 'custom';
export type TemplateOriginType = 'standard' | 'forked' | 'custom_url';

export interface TemplateCatalogItem {
    id: string;
    kind: TemplateKind;
    sourceType: TemplateSourceType;
    originType: TemplateOriginType;
    name: string;
    description?: string | null;
    framework?: string | null;
    previewImageUrl?: string | null;
    repositoryUrl?: string | null;
    repositoryOwner: string;
    repositoryName: string;
    branch: string;
    syncBranches: string[];
    betaBranch?: string | null;
    isActive: boolean;
    isDefault: boolean;
    ownerUserId?: string | null;
    customizable?: boolean;
    baseTemplateId?: string | null;
    lastCustomizedAt?: string | null;
    lastCustomizationPrompt?: string | null;
    latestCustomization?: TemplateCustomizationSummary | null;
}

export interface TemplateCustomizationSummary {
    id: string;
    status: TemplateCustomizationStatus;
    prompt: string;
    errorMessage: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export type TemplateCustomizationStatus =
    | 'pending'
    | 'forking'
    | 'customizing'
    | 'pushing'
    | 'succeeded'
    | 'failed';

export interface TemplateCustomization {
    id: string;
    templateId: string;
    baseTemplateId: string;
    prompt: string;
    status: TemplateCustomizationStatus;
    branch: string | null;
    commitSha: string | null;
    providerId: string | null;
    errorMessage: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export type ListTemplatesResponse = APIResponse<{
    kind: TemplateKind;
    defaultTemplateId: string | null;
    templates: TemplateCatalogItem[];
}>;

export type AddCustomTemplateResponse = APIResponse<{
    template: TemplateCatalogItem;
}>;

export type UpdateCustomTemplateResponse = APIResponse<{
    template: TemplateCatalogItem;
}>;

export type ArchiveCustomTemplateResponse = APIResponse<{
    templateId: string;
    archived: boolean;
}>;

export type SetDefaultTemplateResponse = APIResponse<{
    kind: TemplateKind;
    defaultTemplateId: string;
}>;

export type ForkTemplateResponse = APIResponse<{
    kind: TemplateKind;
    defaultTemplateId: string;
    created: boolean;
    template: TemplateCatalogItem;
    repository: {
        owner: string;
        name: string;
        fullName: string;
        url: string;
    };
}>;

export type RefreshTemplatesResponse = APIResponse<{
    kind: TemplateKind;
    defaultTemplateId: string | null;
    templates: TemplateCatalogItem[];
}>;

export type CustomizeTemplateFromBaseResponse = APIResponse<{
    customizationId: string;
    template: {
        id: string;
        name: string;
        repositoryOwner: string;
        repositoryName: string;
        repositoryUrl: string | null;
    };
    customization: TemplateCustomization;
}>;

export type GetTemplateCustomizationResponse = APIResponse<{
    customization: TemplateCustomization;
}>;

export type IterateCustomTemplateResponse = APIResponse<{
    customizationId: string;
    customization: TemplateCustomization;
}>;

export type SyncCustomTemplateResponse = APIResponse<{
    template: TemplateCatalogItem;
    mode: 'merge' | 'force';
    changed: boolean;
    message: string;
}>;

export interface CustomizationProvider {
    id: string;
    name: string;
    description?: string | null;
    icon?: PluginIcon;
    providerName?: string;
    enabled: boolean;
    isDefault?: boolean;
    // Mirrors the plugin manifest declaration. The dialog renders a conditional
    // AI provider picker when this includes 'ai-provider' (e.g. opencode).
    selectableProviderCategories?: readonly string[];
}

export type ListCustomizationProvidersResponse = APIResponse<{
    providers: CustomizationProvider[];
}>;

export interface CustomizationAiProvider {
    id: string;
    name: string;
    description?: string | null;
    icon?: PluginIcon;
    providerName?: string;
    enabled: boolean;
    isDefault?: boolean;
}

export type ListCustomizationAiProvidersResponse = APIResponse<{
    providers: CustomizationAiProvider[];
}>;

export const templatesAPI = {
    list: async (kind: TemplateKind) => {
        return serverFetch<ListTemplatesResponse>(`/templates?kind=${kind}`);
    },

    addCustom: async (data: {
        kind: TemplateKind;
        repositoryUrl: string;
        name?: string;
        description?: string;
        framework?: string;
        previewImageUrl?: string;
        branch?: string;
        betaBranch?: string;
    }) => {
        return serverMutation<AddCustomTemplateResponse>({
            endpoint: '/templates/custom',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateCustom: async (
        templateId: string,
        data: {
            kind: TemplateKind;
            name?: string;
            description?: string;
            framework?: string;
            previewImageUrl?: string | null;
            branch?: string;
            betaBranch?: string | null;
        },
    ) => {
        return serverMutation<UpdateCustomTemplateResponse>({
            endpoint: `/templates/custom/${templateId}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    archiveCustom: async (templateId: string, data: { kind: TemplateKind }) => {
        return serverMutation<ArchiveCustomTemplateResponse>({
            endpoint: `/templates/custom/${templateId}/archive`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    setDefault: async (data: { kind: TemplateKind; templateId: string }) => {
        return serverMutation<SetDefaultTemplateResponse>({
            endpoint: '/templates/default',
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    fork: async (data: { kind: TemplateKind; templateId: string; targetOwner: string }) => {
        return serverMutation<ForkTemplateResponse>({
            endpoint: '/templates/fork',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    refresh: async (data: { kind: TemplateKind }) => {
        return serverMutation<RefreshTemplatesResponse>({
            endpoint: '/templates/refresh',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    customizeFromBase: async (data: {
        baseTemplateId: string;
        name: string;
        prompt: string;
        providerId: string;
        aiProviderId?: string;
        targetOwner?: string;
        description?: string;
    }) => {
        return serverMutation<CustomizeTemplateFromBaseResponse>({
            endpoint: '/templates/custom-from-base',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    iterateCustom: async (
        templateId: string,
        data: { prompt: string; providerId: string; aiProviderId?: string },
    ) => {
        return serverMutation<IterateCustomTemplateResponse>({
            endpoint: `/templates/custom/${templateId}/customize`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    syncCustom: async (templateId: string, data: { force?: boolean }) => {
        return serverMutation<SyncCustomTemplateResponse>({
            endpoint: `/templates/custom/${templateId}/sync-base`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    getCustomization: async (customizationId: string) => {
        return serverFetch<GetTemplateCustomizationResponse>(
            `/templates/customizations/${customizationId}`,
        );
    },

    listCustomizationProviders: async () => {
        return serverFetch<ListCustomizationProvidersResponse>(
            '/templates/customization-providers',
        );
    },

    listCustomizationAiProviders: async () => {
        return serverFetch<ListCustomizationAiProvidersResponse>(
            '/templates/customization-ai-providers',
        );
    },
};
