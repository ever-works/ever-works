import { AuthResponse } from '../api';
import { ALLOWED_REDIRECT_URLS } from '../constants';
import { addSessionTokenToUrl, isValidRedirectUrl } from '../utils';
import { getRedirectCookie, removeRedirectCookie } from './cookies';

// Security: `isValidRedirectUrl` only validates URL *syntax* — it accepts any
// absolute http(s) URL regardless of host, which is an open redirect: an
// attacker-supplied `redirect_url` cookie pointing at `https://evil.com` would
// otherwise be used as the post-login redirect target (phishing). Restrict
// absolute redirects to hosts in the server-side allowlist (relative paths are
// already constrained by `isValidRedirectUrl`). Host matching mirrors
// `isRedirectAllowedWithSession`/`addSessionTokenToUrl` in lib/utils/url.ts and
// `isRelativeOrAllowedRedirectHost` in app/api/auth/authorize/route.ts
// (exact match + leading `*.` wildcard).
function isRelativeOrAllowedRedirectHost(redirectUrl: string): boolean {
    if (redirectUrl.startsWith('/')) {
        return true;
    }

    try {
        const hostname = new URL(redirectUrl).hostname.toLowerCase();

        return ALLOWED_REDIRECT_URLS.some((allowed) => {
            const cleanAllowed = allowed
                .replace(/^https?:\/\//, '')
                .toLowerCase()
                .trim();

            if (cleanAllowed.startsWith('*.')) {
                const domain = cleanAllowed.slice(2);
                return hostname !== domain && hostname.endsWith('.' + domain);
            }

            return hostname === cleanAllowed;
        });
    } catch {
        return false;
    }
}

export async function getRedirectUrl(authResponse: AuthResponse | null, initialHref: string) {
    const redirectUrl = await getRedirectCookie();

    // Security: require BOTH a syntactically valid URL AND a relative path or
    // allowlisted host before honoring the cookie-supplied redirect target,
    // closing the open redirect on the redirect-consumption path.
    if (
        redirectUrl &&
        isValidRedirectUrl(redirectUrl) &&
        isRelativeOrAllowedRedirectHost(redirectUrl)
    ) {
        await removeRedirectCookie();

        initialHref = authResponse
            ? addSessionTokenToUrl(redirectUrl, authResponse.access_token)
            : redirectUrl;
    }

    return initialHref;
}
