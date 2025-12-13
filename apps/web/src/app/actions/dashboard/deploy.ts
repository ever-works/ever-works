'use server';

import { authAPI, directoryAPI, websiteAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getTranslations } from 'next-intl/server';
import { checkOAuthConnection } from './oauth';
import { revalidatePath } from 'next/cache';
import { deployAPI } from '@/lib/api';

export async function deployToVercel(directoryId: string, vercelTeamScope?: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');
    const tDirectories = await getTranslations('actions.directories');

    try {
        const { directory } = await directoryAPI.get(directoryId);

        // We need to ensure that oauth connection is valid or revoke it if not
        await authAPI.oauth_connections.ensureConnection(directory.repoProvider);

        // Check GitHub connection first
        const oauthCheck = await checkOAuthConnection(directory.repoProvider);
        if (!oauthCheck.connected) {
            return {
                success: false,
                error: tDirectories('oauthRequired', { provider: directory.repoProvider }),
                requiresGitHub: true,
            };
        }

        const response = await deployAPI.deployToVercel(directoryId, {
            vercelTeamScope,
        });

        revalidatePath(ROUTES.DASHBOARD_DIRECTORY_DEPLOY(directoryId));

        return {
            success: response.status === 'success' || response.status === 'pending',
            data: response,
            error: response.status === 'error' ? response.message : null,
        };
    } catch (error) {
        console.error('Deploy to Vercel error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('deployVercelFailed'),
        };
    }
}

export async function updateWebsiteRepository(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');

    try {
        const response = await websiteAPI.updateRepository(directoryId);
        return {
            success: response.status === 'success',
            data: response,
            error: response.status === 'error' ? response.message : null,
        };
    } catch (error) {
        console.error('Update repository error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('updateRepositoryFailed'),
        };
    }
}

export async function getVercelTeams() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.getVercelTeams();
        return {
            success: response.status === 'success',
            teams: response.status === 'success' ? response.teams : [],
        };
    } catch (error) {
        console.error('Get Vercel teams error:', error);
        return {
            success: false,
            teams: [],
            error: error instanceof Error ? error.message : 'Failed to get Vercel teams',
        };
    }
}

export async function lookupExistingDeployment(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.lookupExistingDeployment(directoryId);

        // Ensure the page revalidates when we discover a deployment
        if (response.status === 'success' && response.website) {
            revalidatePath(ROUTES.DASHBOARD_DIRECTORY_DEPLOY(directoryId));
        }

        return {
            success: response.status === 'success',
            website: response.website,
            deploymentState: response.deploymentState,
            found: response.found ?? false,
            error: response.status === 'error' ? response.message || undefined : null,
        };
    } catch (error) {
        console.error('Lookup existing deployment error:', error);
        return {
            success: false,
            website: undefined,
            deploymentState: undefined,
            found: false,
            error: error instanceof Error ? error.message : 'Failed to lookup deployment',
        };
    }
}
