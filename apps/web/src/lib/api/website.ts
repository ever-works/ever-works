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

export type DeployWebsiteResponseDto = APIResponse<{
    slug: string;
    owner: string;
    repository: string;
    message: string;
}>;

export interface DeployWebsiteDto {}

export const websiteAPI = {
    // Deploy to Vercel
    deployToVercel: async (directoryId: string, data: DeployWebsiteDto) => {
        return serverMutation<DeployWebsiteResponseDto>({
            endpoint: `/deploy/directories/${directoryId}/vercel`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Update website repository
    updateRepository: async (directoryId: string) => {
        return serverMutation<UpdateWebsiteRepositoryResponse>({
            endpoint: `/directories/${directoryId}/update-website`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
