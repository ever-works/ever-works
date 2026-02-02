'use server';

import { gitProvidersAPI, GitOrganization } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';

/**
 * Get organizations from the git provider (provider-agnostic)
 */
export async function getGitProviderOrganizations(providerId: string): Promise<{
    success: boolean;
    organizations: GitOrganization[];
    error?: string;
}> {
    const user = await getAuthFromCookie();
    if (!user) {
        return {
            success: false,
            organizations: [],
            error: 'Not authenticated',
        };
    }

    if (!providerId) {
        return {
            success: false,
            organizations: [],
            error: 'Git provider ID is required',
        };
    }

    try {
        const result = await gitProvidersAPI.getOrganizations(providerId);
        return result;
    } catch (error) {
        console.error('Failed to fetch organizations:', error);
        return {
            success: false,
            organizations: [],
            error: error instanceof Error ? error.message : 'Failed to fetch organizations',
        };
    }
}
