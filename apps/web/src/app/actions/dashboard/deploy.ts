'use server';

import { websiteAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';

export async function deployToVercel(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
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
            error: error instanceof Error ? error.message : 'Failed to deploy to Vercel',
        };
    }
}

export async function updateWebsiteRepository(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

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
            error: error instanceof Error ? error.message : 'Failed to update repository',
        };
    }
}
