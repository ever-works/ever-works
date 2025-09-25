import 'server-only';
import { serverMutation } from './server-api';

// Response Types
export interface UpdateWebsiteRepositoryResponse {
    status: 'success' | 'error';
    slug: string;
    owner: string;
    repository: string;
    message: string;
    method_used?: string;
}

export interface DeployWebsiteResponseDto {
    status: 'success' | 'error' | 'pending';
    slug: string;
    owner: string;
    repository: string;
    message: string;
    deployment_url?: string;
}

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
