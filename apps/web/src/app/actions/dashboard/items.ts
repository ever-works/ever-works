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

// Security: SSRF guard for client-supplied source URLs that the API fetches
// server-side (item extraction, screenshot capture). Rejects non-http(s)
// schemes, embedded credentials, and hosts that are loopback / RFC-1918 /
// link-local / unique-local IPs (incl. octal/hex/decimal IPv4 obfuscation and
// IPv6 forms) so an authenticated tenant cannot pivot the backend fetcher to
// internal services or cloud-metadata endpoints (e.g. 169.254.169.254). This
// is defense-in-depth at the web boundary; the backend fetcher should still
// DNS-pin to defeat rebinding. Legitimate public source URLs are unaffected.
function isPrivateIpv4(host: string): boolean {
    // Normalize potential octal/hex/decimal-dotted notations to dotted-decimal.
    const parts = host.split('.');
    if (parts.length !== 4) {
        // Single 32-bit integer form (e.g. http://2130706433/ === 127.0.0.1).
        if (/^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(host)) {
            const n = Number(
                host.toLowerCase().startsWith('0x')
                    ? parseInt(host, 16)
                    : /^0[0-7]+$/.test(host)
                      ? parseInt(host, 8)
                      : host,
            );
            if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return false;
            return isPrivateIpv4(
                [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.'),
            );
        }
        return false;
    }
    const octets = parts.map((p) => {
        if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
        if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
        if (/^\d+$/.test(p)) return parseInt(p, 10);
        return NaN;
    });
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
    const [a, b] = octets;
    return (
        a === 0 || // 0.0.0.0/8 "this host"
        a === 127 || // loopback
        a === 10 || // RFC-1918
        (a === 172 && b >= 16 && b <= 31) || // RFC-1918
        (a === 192 && b === 168) || // RFC-1918
        (a === 169 && b === 254) || // link-local (incl. cloud metadata)
        (a === 100 && b >= 64 && b <= 127) || // CGNAT RFC-6598
        a >= 224 // multicast / reserved
    );
}

function isPrivateIpv6(host: string): boolean {
    let h = host.toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    // IPv4-mapped / -embedded (e.g. ::ffff:169.254.169.254).
    const v4 = h.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (v4 && isPrivateIpv4(v4[1])) return true;
    return (
        h === '::1' || // loopback
        h === '::' || // unspecified
        h.startsWith('fc') || // unique-local fc00::/7
        h.startsWith('fd') ||
        h.startsWith('fe8') || // link-local fe80::/10
        h.startsWith('fe9') ||
        h.startsWith('fea') ||
        h.startsWith('feb')
    );
}

function isSafeExternalUrl(rawUrl: string): boolean {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return false;
    let parsed: URL;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // Reject embedded credentials (SSRF/credential-smuggling obfuscation).
    if (parsed.username !== '' || parsed.password !== '') return false;
    let hostname = parsed.hostname.toLowerCase();
    // Strip IPv6 brackets for the literal-IP checks below.
    const bracketed = hostname.startsWith('[') && hostname.endsWith(']');
    if (bracketed) hostname = hostname.slice(1, -1);
    if (hostname === '') return false;
    // Loopback / internal hostnames.
    if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === 'ip6-localhost' ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        hostname === 'metadata' || // GCP metadata shorthand
        hostname === 'metadata.google.internal'
    ) {
        return false;
    }
    if (hostname.includes(':') || bracketed) {
        if (isPrivateIpv6(hostname)) return false;
    } else if (isPrivateIpv4(hostname)) {
        return false;
    }
    return true;
}

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
        workAPI.getCategoriesTags(workId).catch(() => ({
            categories: [] as Array<string | Category>,
            tags: [] as Array<string | Tag>,
            collections: [] as Array<string | Collection>,
        })),
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
            error_code: response.error_code,
        };
    } catch (error) {
        console.error('Add item error:', error);
        return {
            status: 'error' as const,
            message: error instanceof Error ? error.message : t('error'),
            error_code: 'GENERIC_ERROR' as const,
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
            error_code: response.error_code,
        };
    } catch (error) {
        console.error('Remove item error:', error);
        return {
            status: 'error',
            message: error instanceof Error ? error.message : t('deleteError'),
            error_code: 'GENERIC_ERROR' as const,
        };
    }
}

export async function extractItemDetails(sourceUrl: string, existingCategories?: string[]) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('dashboard.workDetail.items.addModal');

    // Security: block SSRF via attacker-controlled source URLs that the API
    // fetches server-side (internal hosts / cloud metadata) before forwarding.
    if (!isSafeExternalUrl(sourceUrl)) {
        return {
            success: false,
            error: t('extractFailed'),
        };
    }

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
            error_code: response.error_code,
        };
    } catch (error) {
        console.error('Update item error:', error);
        return {
            status: 'error',
            message: error instanceof Error ? error.message : t('updateError'),
            error_code: 'GENERIC_ERROR' as const,
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

    // Security: block SSRF via attacker-controlled URLs that the screenshot
    // provider fetches (internal hosts / cloud metadata) before forwarding.
    if (!isSafeExternalUrl(sourceUrl)) {
        return {
            success: false,
            error: t('captureFailed'),
        };
    }

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
