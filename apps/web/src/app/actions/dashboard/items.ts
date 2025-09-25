'use server';

import { itemsGeneratorAPI, SubmitItemDto, RemoveItemDto } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

export async function addItem(directoryId: string, data: SubmitItemDto) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.directoryDetail.items.addModal');

    try {
        const response = await itemsGeneratorAPI.submitItem(directoryId, data);

        if (response.success) {
            // Revalidate the directory items page to show the new item
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return {
            success: response.success,
            message: response.message || (response.success ? t('success') : t('failed')),
            item: response.item,
        };
    } catch (error) {
        console.error('Add item error:', error);
        return {
            success: false,
            message: error instanceof Error ? error.message : t('error'),
        };
    }
}

export async function removeItem(directoryId: string, itemSlug: string, reason?: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.directoryDetail.items');

    try {
        const response = await itemsGeneratorAPI.removeItem(directoryId, {
            item_slug: itemSlug,
            reason,
        });

        if (response.success) {
            // Revalidate the directory items page to remove the item from the list
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return {
            success: response.success,
            message:
                response.message || (response.success ? t('deleteSuccess') : t('deleteFailed')),
        };
    } catch (error) {
        console.error('Remove item error:', error);
        return {
            success: false,
            message: error instanceof Error ? error.message : t('deleteError'),
        };
    }
}

export async function extractItemDetails(url: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.directoryDetail.items.addModal');

    try {
        const response = await itemsGeneratorAPI.extractItemDetails({ url });

        return {
            success: !response.error,
            data: response.error
                ? null
                : {
                      title: response.title,
                      description: response.description,
                      keywords: response.keywords,
                      tags: response.tags,
                  },
            error: response.error || undefined,
        };
    } catch (error) {
        console.error('Extract item details error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('extractError'),
        };
    }
}
