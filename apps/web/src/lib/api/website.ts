import 'server-only';
import { serverMutation } from './server-api';
import { APIResponse } from './types';

// Response Types
export type UpdateWebsiteRepositoryResponse = APIResponse<{
    slug: string;
    owner: string;
    repository: string;
    message: string;
    method_used?: string;
}>;

export type SwitchWebsiteTemplateResponse = APIResponse<{
    slug: string;
    owner: string;
    repository: string;
    websiteTemplateId: string;
    repositoryRecreated: boolean;
    message: string;
}>;

export const websiteAPI = {
    // Update website repository
    updateRepository: async (directoryId: string) => {
        return serverMutation<UpdateWebsiteRepositoryResponse>({
            endpoint: `/directories/${directoryId}/update-website`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    switchTemplate: async (directoryId: string, websiteTemplateId: string) => {
        return serverMutation<SwitchWebsiteTemplateResponse>({
            endpoint: `/directories/${directoryId}/switch-website-template`,
            data: { websiteTemplateId },
            method: 'POST',
            wrapInData: false,
        });
    },
};
