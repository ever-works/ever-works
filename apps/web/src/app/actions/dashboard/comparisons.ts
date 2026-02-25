'use server';

import { directoryAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { revalidatePath } from 'next/cache';

export async function listComparisons(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        return await directoryAPI.getComparisons(directoryId);
    } catch (error) {
        console.error('List comparisons error:', error);
        return [];
    }
}

export async function getRemainingComparisonCount(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        return await directoryAPI.getRemainingComparisonCount(directoryId);
    } catch (error) {
        console.error('Get remaining comparison count error:', error);
        return { count: 0 };
    }
}

export async function generateNextComparison(directoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await directoryAPI.generateNextComparison(directoryId);

        if (result.status === 'success') {
            revalidatePath(`/directories/${directoryId}/comparisons`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return result;
    } catch (error) {
        console.error('Generate comparison error:', error);
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : 'Failed to generate comparison',
        };
    }
}

export async function generateManualComparison(
    directoryId: string,
    itemASlug: string,
    itemBSlug: string,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await directoryAPI.generateManualComparison(
            directoryId,
            itemASlug,
            itemBSlug,
        );

        if (result.status === 'success') {
            revalidatePath(`/directories/${directoryId}/comparisons`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return result;
    } catch (error) {
        console.error('Generate manual comparison error:', error);
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : 'Failed to generate comparison',
        };
    }
}

export async function deleteComparison(directoryId: string, slug: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await directoryAPI.deleteComparison(directoryId, slug);

        if (result.status === 'success') {
            revalidatePath(`/directories/${directoryId}/comparisons`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return result;
    } catch (error) {
        console.error('Delete comparison error:', error);
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : 'Failed to delete comparison',
        };
    }
}
