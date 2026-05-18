import { redirect } from '@/i18n/navigation';
import { oauthAPI } from '@/lib/api';
import { getOAuthStateCookie, removeOAuthStateCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';
import { appendQueryParams, getOAuthRouteErrorCode } from '../../../callback-errors';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ providerId: string }> },
) {
    const { providerId } = await params;
    const queryParams = request.nextUrl.searchParams;
    const code = queryParams.get('code');
    const state = queryParams.get('state');
    const returnPath = queryParams.get('returnPath');
    const defaultPath = ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('git-provider');
    const targetPath = returnPath || defaultPath;

    const locale = await getLocale();

    if (!code) {
        return redirect({
            locale,
            href: appendQueryParams(targetPath, {
                oauth_error: 'oauth_missing_code',
                oauth_provider: providerId,
            }),
        });
    }

    // C-03: unconditional state check. The previous `if (state && …)` shape
    // skipped validation when the OAuth provider's redirect was missing
    // `?state=` — letting an attacker bypass CSRF by simply stripping the
    // query param. Require state to be present AND match the cookie.
    const storedState = await getOAuthStateCookie();
    if (!state || state !== storedState) {
        await removeOAuthStateCookie();
        return redirect({
            locale,
            href: appendQueryParams(targetPath, {
                oauth_error: 'oauth_invalid_state',
                oauth_provider: providerId,
            }),
        });
    }

    await removeOAuthStateCookie();

    // Build redirect href — redirect() must be called outside try/catch because
    // next-intl's redirect() throws a NEXT_REDIRECT control flow exception internally.
    let href: string;
    try {
        await oauthAPI.connectCallback(providerId, code, state);
        href = appendQueryParams(targetPath, {
            oauth_connected: 'true',
            oauth_provider: providerId,
        });
    } catch (error) {
        console.error(`Failed to connect OAuth provider ${providerId}:`, error);
        href = appendQueryParams(targetPath, {
            oauth_error: getOAuthRouteErrorCode(error, 'oauth_connect_failed'),
            oauth_provider: providerId,
        });
    }

    return redirect({ locale, href });
}
