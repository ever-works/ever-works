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
 * Calls `posthog.identify(userId, ...)` when a known user mounts.
 *
 * Place this INSIDE <PostHogProvider> so posthog-js is already
 * initialized by the time the identify effect runs.
 *
 * `userId` should come from whatever the surrounding tree already knows
 * about the current user (the dashboard layout passes `AuthUser` as a
 * prop from its server component — there's no client-side `useUser()`
 * hook in this repo today).
 *
 * UNMOUNT RESET — the real logout path on this platform redirects the
 * whole dashboard layout to the login page, which unmounts this
 * component without `userId` ever transitioning to falsy on a still-
 * mounted instance. Relying purely on the prop-change branch below
 * would leave PostHog's distinct_id pinned to the departing user for
 * the rest of the tab's lifetime. To avoid that, a second effect runs
 * `posthog.reset()` in its UNMOUNT cleanup so logout / route-tear-down
 * always drops the prior identity.
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

    useEffect(() => {
        if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
        return () => {
            // Logout typically unmounts the dashboard layout entirely
            // rather than flipping `userId` to null on a mounted
            // instance, so the identify effect above never sees the
            // transition. Reset here so the next mount starts clean.
            posthog.reset();
        };
    }, []);

    return null;
}
