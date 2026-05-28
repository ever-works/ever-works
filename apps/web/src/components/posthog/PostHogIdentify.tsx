'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';

interface PostHogIdentifyProps {
    /**
     * Stable internal user id. Same value used everywhere else for
     * user identity (matches `AuthUser.id`).
     */
    userId?: string | null;
    email?: string | null;
    name?: string | null;
}

/**
 * Calls `posthog.identify(userId, ...)` when a known user mounts and
 * `posthog.reset()` when the user goes away (logout / unmount).
 *
 * Place this INSIDE <PostHogProvider> so posthog-js is already
 * initialized by the time the identify effect runs.
 *
 * `userId` should come from whatever the surrounding tree already knows
 * about the current user (the dashboard layout passes `AuthUser` as a
 * prop from its server component — there's no client-side `useUser()`
 * hook in this repo today).
 */
export function PostHogIdentify({ userId, email, name }: PostHogIdentifyProps) {
    useEffect(() => {
        if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

        if (userId) {
            const props: Record<string, string> = {};
            if (email) props.email = email;
            if (name) props.name = name;
            posthog.identify(userId, props);
        } else {
            // Unknown user (logged out, anonymous surface). Drop any prior
            // identity so the next session starts as a fresh anonymous id.
            posthog.reset();
        }
    }, [userId, email, name]);

    return null;
}
