'use server';

import { directoryAPI } from '@/lib/api/directory';
import { deployAPI, type DeployProvider } from '@/lib/api/plugins-capabilities/deploy';
import { getAuthFromCookie } from '@/lib/auth';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { ROUTES } from '@/lib/constants';
import { redirect } from 'next/navigation';

export async function getDeployProviders(): Promise<DeployProvider[]> {
    const user = await getAuthFromCookie();
    if (!user) {
        return [];
    }

    try {
        const res = await deployAPI.getProviders();
        return res.providers ?? [];
    } catch (error) {
        console.error('Failed to fetch deploy providers:', error);
        return [];
    }
}

export async function updateDeployProvider(directoryId: string, deployProvider: string) {
    const t = await getTranslations('actions.directories');
    const user = await getAuthFromCookie();

    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        await directoryAPI.update(directoryId, {
            deployProvider,
        });

        revalidatePath(ROUTES.DASHBOARD_DIRECTORY_SETTINGS(directoryId));

        return {
            success: true,
            message: t('updateSuccess'),
        };
    } catch (error) {
        console.error('Failed to update deploy provider:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('updateFailed'),
        };
    }
}
