'use server';

import { itemsGeneratorAPI, SubmitItemDto, RemoveItemDto, UpdateItemDto } from '@/lib/api';
import { screenshotAPI } from '@/lib/api/screenshot';
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

        if (response.status === 'success') {
            // Revalidate the directory items page to show the new item
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return {
            status: response.status,
            message:
                response.message || (response.status === 'success' ? t('success') : t('failed')),
            // Return the full item data for immediate list update
            item: response.item,
            item_slug: response.item_slug,
            auto_merged: response.auto_merged,
            pr_url: response.pr_url,
            pr_number: response.pr_number,
        };
    } catch (error) {
        console.error('Add item error:', error);
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : t('error'),
        };
    }
}

export async function removeItem(
    directoryId: string,
    itemSlug: string,
    options?: { reason?: string; create_pull_request?: boolean },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.directoryDetail.items');

    try {
        const response = await itemsGeneratorAPI.removeItem(directoryId, {
            item_slug: itemSlug,
            reason: options?.reason,
            create_pull_request: options?.create_pull_request,
        });

        if (response.status) {
            // Revalidate the directory items page to remove the item from the list
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return {
            status: response.status,
            message:
                response.message ||
                (response.status === 'success' ? t('deleteSuccess') : t('deleteFailed')),
        };
    } catch (error) {
        console.error('Remove item error:', error);
        return {
            status: 'error',
            message: error instanceof Error ? error.message : t('deleteError'),
        };
    }
}

export async function extractItemDetails(sourceUrl: string, existingCategories?: string[]) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.directoryDetail.items.addModal');

    try {
        const response = await itemsGeneratorAPI.extractItemDetails({
            source_url: sourceUrl,
            existing_categories:
                existingCategories && existingCategories.length > 0
                    ? existingCategories
                    : undefined,
        });

        if (response.status !== 'success' || !response.item) {
            return {
                success: false,
                error: response.message || t('extractFailed'),
            };
        }

        // Normalize category to string (take first if array)
        const normalizedCategory = Array.isArray(response.item.category)
            ? response.item.category[0]
            : response.item.category;

        const normalizedTags = (response.item.tags || []).map((tag) =>
            typeof tag === 'string' ? tag : tag.name,
        );

        const normalizedBrand =
            typeof response.item.brand === 'string'
                ? response.item.brand
                : response.item.brand?.name;

        return {
            success: true,
            data: {
                name: response.item.name,
                description: response.item.description,
                category: normalizedCategory,
                tags: normalizedTags,
                brand: normalizedBrand,
                brand_logo_url: response.item.brand_logo_url || undefined,
                images: response.item.images || [],
            },
            message: response.message,
        };
    } catch (error) {
        console.error('Extract item details error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('extractError'),
        };
    }
}

export async function updateItem(directoryId: string, data: UpdateItemDto) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.directoryDetail.items');

    try {
        const response = await itemsGeneratorAPI.updateItem(directoryId, data);

        if (response.status === 'success') {
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return {
            status: response.status,
            message:
                response.message ||
                (response.status === 'success' ? t('updateSuccess') : t('updateFailed')),
            item: response,
        };
    } catch (error) {
        console.error('Update item error:', error);
        return {
            status: 'error',
            message: error instanceof Error ? error.message : t('updateError'),
        };
    }
}

export async function captureScreenshot(sourceUrl: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.directoryDetail.items.screenshot');

    try {
        // First check if the service is available
        const availability = await screenshotAPI.checkAvailability();

        if (!availability.available) {
            return {
                success: false,
                error: t('notConfigured'),
            };
        }

        // Get the screenshot URL
        const response = await screenshotAPI.getScreenshotUrl({
            url: sourceUrl,
            blockAds: true,
            blockTrackers: true,
            blockCookieBanners: true,
        });

        if (response.status !== 'success' || !response.imageUrl) {
            return {
                success: false,
                error: response.message || t('captureFailed'),
            };
        }

        return {
            success: true,
            imageUrl: response.imageUrl,
            message: t('captureSuccess'),
        };
    } catch (error) {
        console.error('Capture screenshot error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('captureError'),
        };
    }
}

export async function checkScreenshotAvailability() {
    const user = await getAuthFromCookie();
    if (!user) {
        return { available: false };
    }

    try {
        const availability = await screenshotAPI.checkAvailability();
        return {
            available: availability.available,
            hasGlobalKey: availability.hasGlobalKey,
            hasUserKey: availability.hasUserKey,
        };
    } catch {
        return { available: false };
    }
}

export async function captureSmartImage(
    sourceUrl: string,
    domainType?: 'software' | 'ecommerce' | 'services' | 'general',
    itemName?: string,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.directoryDetail.items.screenshot');

    try {
        const response = await screenshotAPI.getSmartImage({
            url: sourceUrl,
            domainType,
            itemName,
        });

        if (response.status !== 'success' || !response.primaryImage) {
            return {
                success: false,
                error: response.error || t('captureFailed'),
            };
        }

        return {
            success: true,
            imageUrl: response.primaryImage,
            source: response.source,
            confidence: response.confidence,
            message: t('captureSuccess'),
        };
    } catch (error) {
        console.error('Smart image capture error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('captureError'),
        };
    }
}

export async function bulkCaptureImages(
    directoryId: string,
    options: { itemSlugs?: string[]; mode: 'missing' | 'all' },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.directoryDetail.items.screenshot');

    try {
        const response = await screenshotAPI.bulkCaptureImages(directoryId, {
            itemSlugs: options.itemSlugs,
            mode: options.mode,
        });

        // Revalidate the directory items page
        revalidatePath(`/directories/${directoryId}/items`);
        revalidatePath(`/directories/${directoryId}`);

        return {
            success: response.status !== 'error',
            status: response.status,
            results: response.results,
            totalProcessed: response.totalProcessed,
            successCount: response.successCount,
            errorCount: response.errorCount,
            message: response.message || t('bulkCaptureComplete'),
        };
    } catch (error) {
        console.error('Bulk capture images error:', error);
        return {
            success: false,
            status: 'error' as const,
            results: [],
            totalProcessed: 0,
            successCount: 0,
            errorCount: 0,
            message: error instanceof Error ? error.message : t('bulkCaptureError'),
        };
    }
}
