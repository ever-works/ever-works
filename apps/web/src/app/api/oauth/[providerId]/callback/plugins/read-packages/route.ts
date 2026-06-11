import { redirect } from '@/i18n/navigation';
import { oauthAPI } from '@/lib/api';
import { OAuthProvider } from '@/lib/api/enums';
import { getOAuthStateCookie, removeOAuthStateCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { isValidRedirectUrl } from '@/lib/utils';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';
import { appendQueryParams, getOAuthRouteErrorCode } from '../../../../callback-errors';

/**
 * Callback route for the GitHub read-packages OAuth flow. Mirrors the main
 * plugins-callback route but calls `oauthAPI.readPackagesCallback()` which
 * writes the resulting access token into the user's GitHub plugin settings
 * under `readPackagesPat` — instead of replacing the main OAuth connection.
 *
 * On success/error the user is redirected back to the git-provider plugin
 * settings page (or the explicit `returnPath` if one was provided when the
 * flow was initiated) with the same `oauth_*` query-string contract the
 * main callback uses, so the existing toast / inline messaging surfaces
 * the result without extra UI plumbing.
 */
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
    // Mirrors the main plugins-callback route.
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
                oauth_intent: 'read_packages',
            }),
        });
    }

    // C-03: unconditional state check. Mirror of the main plugins callback —
    // require state to be present AND match the cookie, so an attacker can't
    // bypass CSRF by stripping the `?state=` param from the OAuth redirect.
    const storedState = await getOAuthStateCookie();
    if (!state || state !== storedState) {
        await removeOAuthStateCookie();
        return redirect({
            locale,
            href: appendQueryParams(targetPath, {
                oauth_error: 'oauth_invalid_state',
                oauth_provider: providerId,
                oauth_intent: 'read_packages',
            }),
        });
    }

    await removeOAuthStateCookie();

    // Security: validate the `providerId` route segment against the known
    // provider enum before forwarding it. It is interpolated into the
    // server-to-server API path inside `oauthAPI.readPackagesCallback`, so an
    // unrecognized/crafted value must not reach the backend. Mirrors the main
    // plugins-callback route's enum check.
    if (!Object.values(OAuthProvider).includes(providerId as OAuthProvider)) {
        return redirect({
            locale,
            href: appendQueryParams(defaultPath, {
                oauth_error: 'oauth_unsupported_provider',
                oauth_provider: providerId,
                oauth_intent: 'read_packages',
            }),
        });
    }

    let href: string;
    try {
        await oauthAPI.readPackagesCallback(providerId, code, state);
        href = appendQueryParams(targetPath, {
            oauth_connected: 'true',
            oauth_provider: providerId,
            oauth_intent: 'read_packages',
        });
    } catch (error) {
        console.error(`Failed to complete read-packages OAuth flow for ${providerId}:`, error);
        href = appendQueryParams(targetPath, {
            oauth_error: getOAuthRouteErrorCode(error, 'oauth_connect_failed'),
            oauth_provider: providerId,
            oauth_intent: 'read_packages',
        });
    }

    return redirect({ locale, href });
}
