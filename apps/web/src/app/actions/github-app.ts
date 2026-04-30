'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { githubAppAPI } from '@/lib/api/github-app';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    return user;
}

export async function syncGitHubAppInstallation(installationId: string) {
    await ensureAuth();

    try {
        const data = await githubAppAPI.syncInstallation(installationId);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_GITHUB_APP);

        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error:
                error instanceof Error ? error.message : 'Failed to sync GitHub App installation',
        };
    }
}

export async function onboardGitHubAppRepository(installationId: string, repositoryId: string) {
    await ensureAuth();

    try {
        const data = await githubAppAPI.onboardRepository(installationId, repositoryId);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_GITHUB_APP);

        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error:
                error instanceof Error ? error.message : 'Failed to onboard GitHub App repository',
        };
    }
}
