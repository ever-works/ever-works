import { createAuthClient } from 'better-auth/react';

const WEB_URL =
    process.env.NEXT_PUBLIC_WEB_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export const authClient = createAuthClient({
    // Use the Next.js app as the public auth origin and proxy requests to the API.
    // This avoids browser-side cross-origin OAuth initiation issues and keeps cookies same-origin.
    baseURL: WEB_URL,
    basePath: '/api/auth/provider',
});
