import 'server-only';
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
}

export type ListTemplatesResponse = APIResponse<{
    kind: TemplateKind;
    defaultTemplateId: string | null;
    templates: TemplateCatalogItem[];
}>;

export type AddCustomTemplateResponse = APIResponse<{
    template: TemplateCatalogItem;
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
    }) => {
        return serverMutation<AddCustomTemplateResponse>({
            endpoint: '/templates/custom',
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
};
