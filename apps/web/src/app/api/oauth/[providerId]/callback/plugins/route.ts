import { redirect } from '@/i18n/navigation';
import { oauthAPI } from '@/lib/api';
import { OAuthProvider } from '@/lib/api/enums';
import { getOAuthStateCookie, removeOAuthStateCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { isValidRedirectUrl } from '@/lib/utils';
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
    // Security: `returnPath` is attacker-controllable (it round-trips through the
    // OAuth callback query string). Although `appendQueryParams` already strips
    // any foreign host, validate on read so the only accepted values are safe
    // same-origin relative paths — rejecting protocol-relative ("//evil.com"),
    // backslash-obfuscated, and absolute targets up front and hardening against a
    // future refactor that uses `targetPath` without `appendQueryParams`.
    const targetPath =
        returnPath && isValidRedirectUrl(returnPath) && returnPath.startsWith('/')
            ? returnPath
            : defaultPath;

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

    // Security: validate the `providerId` route segment against the known
    // provider enum before forwarding it. It is interpolated into the
    // server-to-server API path inside `oauthAPI.connectCallback`, so an
    // unrecognized/crafted value must not reach the backend. Mirrors the main
    // OAuth callback handler's enum check.
    if (!Object.values(OAuthProvider).includes(providerId as OAuthProvider)) {
        return redirect({
            locale,
            href: appendQueryParams(defaultPath, {
                oauth_error: 'oauth_unsupported_provider',
                oauth_provider: providerId,
            }),
        });
    }

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
