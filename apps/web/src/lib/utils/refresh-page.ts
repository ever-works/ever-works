'use client';

import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { LOCALES } from '@/lib/constants';

const LOCALE_PREFIX_PATTERN = new RegExp(`^/(?:${LOCALES.join('|')})(?=/|$)`);

function toInternalPathname(pathname: string): string {
    const normalizedPathname = pathname.replace(LOCALE_PREFIX_PATTERN, '');
    return normalizedPathname || '/';
}

/**
 * Performs interval refresh of the current page.
 * @param router - useRouter() instance
 * @param intervalInMs - interval in milliseconds (default 10s)
 * @returns
 */
export function pageIntervalRefresh(router: AppRouterInstance, intervalInMs: number = 10 * 1000) {
    const interval = setInterval(() => {
        // Save current scroll position
        const scrollY = window.scrollY;
        const scrollX = window.scrollX;
        const currentPath = `${toInternalPathname(window.location.pathname)}${window.location.search}`;

        // Re-navigate to the current route explicitly. This is more reliable than
        // router.refresh() for nested dynamic routes where refresh can collapse
        // back to the default child segment.
        router.replace(currentPath);

        // Restore scroll position after a small delay
        requestAnimationFrame(() => {
            window.scrollTo(scrollX, scrollY);
        });
    }, intervalInMs);

    return () => clearInterval(interval);
}
