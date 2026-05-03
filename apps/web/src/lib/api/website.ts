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
    previousWebsiteTemplateId: string;
    websiteTemplateId: string;
    repositoryRecreated: boolean;
    switchMode:
        | 'no_change'
        | 'saved_for_initialization'
        | 'repository_reset'
        | 'repository_recreated';
    message: string;
}>;

export const websiteAPI = {
    // Update website repository
    updateRepository: async (workId: string) => {
        return serverMutation<UpdateWebsiteRepositoryResponse>({
            endpoint: `/works/${workId}/update-website`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    switchTemplate: async (workId: string, websiteTemplateId: string) => {
        return serverMutation<SwitchWebsiteTemplateResponse>({
            endpoint: `/works/${workId}/switch-website-template`,
            data: { websiteTemplateId },
            method: 'POST',
            wrapInData: false,
        });
    },
};
