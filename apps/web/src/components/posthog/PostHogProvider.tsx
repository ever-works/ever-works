'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import { PostHogProvider as PHProvider } from 'posthog-js/react';

/**
 * Client-side PostHog wiring for the platform's web frontend.
 *
 * Autocapture + session replay are enabled. PII masking defaults err on
 * the side of "do not mask everything" — input values are recorded so
 * funnel analysis is useful, but password and email inputs are masked
 * because they carry credentials / PII.
 *
 * Pageviews are captured manually (`capture_pageview: false`) so that
 * App Router client-side navigations between routes are counted. The
 * companion <PostHogPageview /> component fires `$pageview` on every
 * `usePathname` / `useSearchParams` change.
 *
 * If `NEXT_PUBLIC_POSTHOG_KEY` is absent at BUILD time (NEXT_PUBLIC_*
 * are baked at build), `posthog-js` silently no-ops — this is fail-open
 * by design for OSS forks that don't run PostHog.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
    useEffect(() => {
        if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

        posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
            api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
            // We capture $pageview manually below so SPA route changes count.
            capture_pageview: false,
            capture_pageleave: true,
            // Default is `true`, but be explicit for reviewer clarity.
            autocapture: true,
            session_recording: {
                // Recording values is desirable for funnel analysis. Mask only
                // password + email inputs.
                maskAllInputs: false,
                maskInputOptions: { password: true, email: true },
            },
            persistence: 'localStorage+cookie',
            loaded: (ph) => {
                if (process.env.NODE_ENV === 'development') ph.debug();
            },
        });
    }, []);

    return (
        <PHProvider client={posthog}>
            {/* Suspense is required: `useSearchParams` triggers a CSR bailout
                for the whole route if it's not wrapped, which would force
                every page below into client rendering. */}
            <Suspense fallback={null}>
                <PostHogPageview />
            </Suspense>
            {children}
        </PHProvider>
    );
}

/**
 * Fires `$pageview` on every App Router navigation. The native
 * `capture_pageview` PostHog option only triggers on full document loads,
 * which never happens in an SPA after first paint.
 */
export function PostHogPageview() {
    const pathname = usePathname();
    const searchParams = useSearchParams();

    useEffect(() => {
        if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
        if (!pathname) return;

        let url = window.origin + pathname;
        const qs = searchParams?.toString();
        if (qs) {
            url = url + '?' + qs;
        }

        posthog.capture('$pageview', { $current_url: url });
    }, [pathname, searchParams]);

    return null;
}
