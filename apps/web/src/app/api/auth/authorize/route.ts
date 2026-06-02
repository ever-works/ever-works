import { redirect } from '@/i18n/navigation';
import { getAuthFromRequest, setRedirectCookie } from '@/lib/auth';
import { ALLOWED_REDIRECT_URLS, REDIRECT_SEARCH_PARAM, ROUTES } from '@/lib/constants';
import { addSessionTokenToUrl, isValidRedirectUrl } from '@/lib/utils';
import { getLocale } from 'next-intl/server';
import type { NextRequest } from 'next/server';

// Security: `isValidRedirectUrl` only validates URL *syntax* — it accepts any
// absolute http(s) URL regardless of host. That allows an open redirect: an
// attacker-supplied `redirect_uri=https://evil.com` is stored in a cookie (anon
// flow) or used directly (authenticated flow) and the victim is sent to the
// external origin after login (phishing). Restrict redirects to relative paths
// OR hosts in the server-side allowlist. Host matching mirrors
// `isRedirectAllowedWithSession` in lib/utils/url.ts (exact match + `*.` wildcard).
function isRelativeOrAllowedRedirectHost(redirectUrl: string): boolean {
    // Relative paths are already validated (and protocol-relative/backslash
    // targets rejected) by `isValidRedirectUrl`.
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

export async function GET(request: NextRequest) {
    const redirectUrl = request.nextUrl.searchParams.get(REDIRECT_SEARCH_PARAM);
    const locale = await getLocale();

    if (
        !redirectUrl ||
        !isValidRedirectUrl(redirectUrl) ||
        !isRelativeOrAllowedRedirectHost(redirectUrl)
    ) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=authorize_invalid_redirect_url',
        });
    }

    const auth = await getAuthFromRequest().catch(() => null);

    if (auth?.isAuthenticated && !auth.isExpired) {
        return redirect({
            locale,
            href: addSessionTokenToUrl(redirectUrl, auth.token),
        });
    }

    await setRedirectCookie(redirectUrl);

    return redirect({ locale, href: ROUTES.AUTH_LOGIN });
}
