import { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';

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

        // Refresh the page
        router.refresh();

        // Restore scroll position after a small delay
        requestAnimationFrame(() => {
            window.scrollTo(scrollX, scrollY);
        });
    }, intervalInMs);

    return () => clearInterval(interval);
}
