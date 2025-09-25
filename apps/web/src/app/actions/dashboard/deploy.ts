'use server';

import { authAPI, directoryAPI, websiteAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getTranslations } from 'next-intl/server';
import { checkOAuthConnection } from './oauth';

export async function deployToVercel(directoryId: string) {
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

        const response = await websiteAPI.deployToVercel(directoryId, {});
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
