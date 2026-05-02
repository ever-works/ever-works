'use server';

import { itemsGeneratorAPI, SubmitItemDto, UpdateItemDto } from '@/lib/api';
import { screenshotAPI } from '@/lib/api';
import { directoryAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { DirectoryScheduleCadence } from '@/lib/api/enums';

export async function addItem(directoryId: string, data: SubmitItemDto) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.workDetail.items.addModal');

    try {
        const response = await itemsGeneratorAPI.submitItem(directoryId, data);

        if (response.status === 'success') {
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return {
            status: response.status,
            message:
                response.message || (response.status === 'success' ? t('success') : t('failed')),
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

    const t = await getTranslations('dashboard.workDetail.items');

    try {
        const response = await itemsGeneratorAPI.removeItem(directoryId, {
            item_slug: itemSlug,
            reason: options?.reason,
            create_pull_request: options?.create_pull_request,
        });

        if (response.status) {
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

    const t = await getTranslations('dashboard.workDetail.items.addModal');

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

    const t = await getTranslations('dashboard.workDetail.items');

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

export async function checkItemHealth(directoryId: string, itemSlug: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.workDetail.items');

    try {
        const response = await itemsGeneratorAPI.checkItemHealth(directoryId, {
            item_slug: itemSlug,
        });

        if (response.status === 'success') {
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
        }

        return {
            status: response.status,
            message:
                response.message ||
                (response.status === 'success'
                    ? t('sourceValidation.checkCompleted')
                    : t('sourceValidation.checkFailed')),
            item: response.item,
        };
    } catch (error) {
        console.error('Check item health error:', error);
        return {
            status: 'error' as const,
            message:
                error instanceof Error ? error.message : t('sourceValidation.failedToCheckSource'),
        };
    }
}

export async function captureScreenshot(
    sourceUrl: string,
    options?: { directoryId?: string; providerOverride?: string },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.workDetail.items.screenshot');

    try {
        const availability = await screenshotAPI.checkAvailability(options?.directoryId);

        if (!availability.available) {
            return {
                success: false,
                error: t('notConfigured'),
            };
        }

        const configuredProviders = availability.providers.filter(
            (provider) => provider.configured,
        );
        const providerOverride =
            options?.providerOverride ??
            (availability.activeProvider?.configured
                ? availability.activeProvider.id
                : undefined) ??
            configuredProviders[0]?.id;

        if (!providerOverride) {
            return {
                success: false,
                error: t('notConfigured'),
            };
        }

        const response = await screenshotAPI.getScreenshotUrl({
            url: sourceUrl,
            providerOverride,
            directoryId: options?.directoryId,
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

export async function checkScreenshotAvailability(directoryId?: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { available: false, providers: [], activeProvider: null };
    }

    try {
        const availability = await screenshotAPI.checkAvailability(directoryId);
        return {
            available: availability.available,
            providers: availability.providers,
            activeProvider: availability.activeProvider ?? null,
        };
    } catch {
        return { available: false, providers: [], activeProvider: null };
    }
}

export async function updateSourceValidationSettings(
    directoryId: string,
    payload: { enabled: boolean; cadence?: DirectoryScheduleCadence },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { status: 'error' as const, message: 'Not authenticated' };
    }

    try {
        await directoryAPI.updateSourceValidationSettings(directoryId, payload);
        revalidatePath(ROUTES.DASHBOARD_DIRECTORY_ITEMS(directoryId));
        return { status: 'success' as const };
    } catch (error) {
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : 'Failed to update settings',
        };
    }
}
