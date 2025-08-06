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
    error_details?: string;
}

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
};
