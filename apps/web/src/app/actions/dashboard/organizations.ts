'use server';

import { authAPI, GitHubOrganization } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';

export async function getGitHubOrganizations(): Promise<{
    success: boolean;
    organizations?: GitHubOrganization[];
    error?: string;
}> {
    const user = await getAuthFromCookie();
    if (!user) {
        return {
            success: false,
            error: 'Not authenticated',
        };
    }

    try {
        const organizations = await authAPI.oauth_connections.getGitHubOrgs();
        return {
            success: true,
            organizations,
        };
    } catch (error) {
        console.error('Failed to fetch GitHub organizations:', error);
        return {
            success: false,
            error: 'Failed to fetch organizations',
            organizations: [],
        };
    }
}
