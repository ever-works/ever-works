'use client';

import { Inbox } from '@novu/react';

/**
 * EW-665 — optional Novu notification inbox widget.
 *
 * Renders Novu's official `<Inbox>` React component when a Novu
 * application identifier is configured (`NEXT_PUBLIC_NOVU_APP_ID`);
 * otherwise it's a no-op so the dashboard works without Novu wired.
 *
 * `subscriberId` is the current user's id. `subscriberHash` (HMAC of the
 * subscriber id, computed server-side from `NOVU_SECRET_KEY`) enables
 * Novu's secured/HMAC mode; when absent, Novu runs in non-secured mode.
 * `backendUrl` / `socketUrl` point at a self-hosted Novu when set.
 */
export function NovuInbox({
    subscriberId,
    subscriberHash,
}: {
    subscriberId: string;
    subscriberHash?: string;
}) {
    const applicationIdentifier = process.env.NEXT_PUBLIC_NOVU_APP_ID;
    if (!applicationIdentifier || !subscriberId) {
        return null;
    }

    const backendUrl = process.env.NEXT_PUBLIC_NOVU_BACKEND_URL;
    const socketUrl = process.env.NEXT_PUBLIC_NOVU_SOCKET_URL;

    return (
        <Inbox
            applicationIdentifier={applicationIdentifier}
            subscriberId={subscriberId}
            {...(subscriberHash ? { subscriberHash } : {})}
            {...(backendUrl ? { backendUrl } : {})}
            {...(socketUrl ? { socketUrl } : {})}
        />
    );
}
