'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import { PostHogProvider as PHProvider } from 'posthog-js/react';

/**
 * Client-side PostHog wiring for the platform's web frontend.
 *
 * Autocapture + session replay are enabled. Session-replay inputs are
 * masked WHOLESALE (`maskAllInputs: true`) — per-type masking via
 * `maskInputOptions` is unreliable because apps routinely render
 * sensitive fields (API keys, secrets, custom autocomplete pickers,
 * older form patterns) as `input[type="text"]` rather than the strict
 * `password` / `email` types. Masking everything is the secure-by-default
 * posture PostHog's own security docs recommend.
 *
 * Pageviews are captured manually (`capture_pageview: false`) so that
 * App Router client-side navigations between routes are counted. The
 * companion <PostHogPageview /> component fires `$pageview` on every
 * `usePathname` / `useSearchParams` change.
 *
 * INIT TIMING — `posthog.init(...)` runs at MODULE LOAD time (not inside
 * a `useEffect`). React commits children's effects before parent's, so
 * doing init in the provider's effect would let `<PostHogIdentify>` and
 * `<PostHogPageview>` call `posthog.identify(...)` / `posthog.capture(...)`
 * BEFORE init has run — posthog-js silently no-ops pre-init, dropping
 * the first pageview and first identify of every session. Running init
 * at module scope guarantees it has already executed by the time any
 * child effect fires. `posthog.init` is idempotent per posthog-js docs,
 * so re-imports / HMR are safe.
 *
 * If `NEXT_PUBLIC_POSTHOG_KEY` is absent at BUILD time (NEXT_PUBLIC_*
 * are baked at build), the module-scope init is skipped and posthog-js
 * silently no-ops — this is fail-open by design for OSS forks that
 * don't run PostHog.
 */
if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
        // We capture $pageview manually below so SPA route changes count.
        capture_pageview: false,
        capture_pageleave: true,
        // Default is `true`, but be explicit for reviewer clarity.
        autocapture: true,
        session_recording: {
            // Mask every input regardless of `type`. Per-type masking
            // (`maskInputOptions: { email: true, password: true }`) only
            // matches the literal `input[type]` attribute, so anything
            // rendered as `type="text"` — API key fields, custom
            // autocomplete, legacy forms — would otherwise be recorded
            // verbatim. Secure by default.
            maskAllInputs: true,
        },
        persistence: 'localStorage+cookie',
        loaded: (ph) => {
            if (process.env.NODE_ENV === 'development') ph.debug();
        },
    });
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
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
