'use server';

import { itemsGeneratorAPI, SubmitItemDto, UpdateItemDto } from '@/lib/api';
import type { Category, Collection, ItemData, Tag } from '@/lib/api';
import { screenshotAPI } from '@/lib/api';
import { workAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { WorkScheduleCadence } from '@/lib/api/enums';

export type LoadItemsForListResult = {
    items: ItemData[];
    categories: Category[];
    tags: Tag[];
    collections: Collection[];
};

/**
 * Server action that fetches the items + taxonomy needed to populate
 * the Items tab. Splits off the page's SSR data so the route shell
 * (title, tabs, search input) renders instantly while this slow call
 * — which still triggers a `cloneOrPull()` of the data repo on the
 * API side, since items live as Markdown files in git — resolves in
 * the background and the client swaps the skeletons for real rows.
 */
export async function loadItemsForList(workId: string): Promise<LoadItemsForListResult> {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const [itemsRes, taxonomyRes] = await Promise.all([
        workAPI.getItems(workId).catch(() => ({ items: [] as ItemData[] })),
        workAPI
            .getCategoriesTags(workId)
            .catch(() => ({ categories: [] as string[], tags: [] as string[], collections: [] as string[] })),
    ]);

    const normalize = <T extends { id: string; name: string }>(
        raw: ReadonlyArray<string | T>,
    ): T[] =>
        raw.map((entry) => (typeof entry === 'string' ? ({ id: entry, name: entry } as T) : entry));

    return {
        items: itemsRes.items ?? [],
        categories: normalize<Category>(taxonomyRes.categories ?? []),
        tags: normalize<Tag>(taxonomyRes.tags ?? []),
        collections: normalize<Collection>(taxonomyRes.collections ?? []),
    };
}

export async function addItem(workId: string, data: SubmitItemDto) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.workDetail.items.addModal');

    try {
        const response = await itemsGeneratorAPI.submitItem(workId, data);

        if (response.status === 'success') {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
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
    workId: string,
    itemSlug: string,
    options?: { reason?: string; create_pull_request?: boolean },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.workDetail.items');

    try {
        const response = await itemsGeneratorAPI.removeItem(workId, {
            item_slug: itemSlug,
            reason: options?.reason,
            create_pull_request: options?.create_pull_request,
        });

        if (response.status) {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
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

export async function updateItem(workId: string, data: UpdateItemDto) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.workDetail.items');

    try {
        const response = await itemsGeneratorAPI.updateItem(workId, data);

        if (response.status === 'success') {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
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

export async function checkItemHealth(workId: string, itemSlug: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.workDetail.items');

    try {
        const response = await itemsGeneratorAPI.checkItemHealth(workId, {
            item_slug: itemSlug,
        });

        if (response.status === 'success') {
            revalidatePath(`/works/${workId}/items`);
            revalidatePath(`/works/${workId}`);
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
    options?: { workId?: string; providerOverride?: string },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.workDetail.items.screenshot');

    try {
        const availability = await screenshotAPI.checkAvailability(options?.workId);

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
            workId: options?.workId,
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

export async function checkScreenshotAvailability(workId?: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { available: false, providers: [], activeProvider: null };
    }

    try {
        const availability = await screenshotAPI.checkAvailability(workId);
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
    workId: string,
    payload: { enabled: boolean; cadence?: WorkScheduleCadence },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        return { status: 'error' as const, message: 'Not authenticated' };
    }

    try {
        await workAPI.updateSourceValidationSettings(workId, payload);
        revalidatePath(ROUTES.DASHBOARD_WORK_ITEMS(workId));
        return { status: 'success' as const };
    } catch (error) {
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : 'Failed to update settings',
        };
    }
}
