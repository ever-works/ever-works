const PROVIDER_CONFLICT_SNIPPET = 'already linked to another user';
const ACCOUNT_LOCKED_SNIPPET = 'suspended';

export type OAuthRouteErrorCode =
    | 'account_locked'
    | 'oauth_callback'
    | 'oauth_connect_failed'
    | 'oauth_provider_conflict';

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || '');
}

export function getOAuthRouteErrorCode(
    error: unknown,
    fallback: OAuthRouteErrorCode,
): OAuthRouteErrorCode {
    const message = getErrorMessage(error).toLowerCase();

    if (message.includes(PROVIDER_CONFLICT_SNIPPET)) {
        return 'oauth_provider_conflict';
    }

    if (message.includes(ACCOUNT_LOCKED_SNIPPET)) {
        return 'account_locked';
    }

    return fallback;
}

export function appendQueryParams(
    href: string,
    params: Record<string, string | undefined>,
): string {
    const url = new URL(href, 'http://localhost');

    for (const [key, value] of Object.entries(params)) {
        if (!value) {
            continue;
        }
        url.searchParams.set(key, value);
    }

    return `${url.pathname}${url.search}${url.hash}`;
}
