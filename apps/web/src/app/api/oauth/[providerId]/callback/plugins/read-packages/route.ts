import { redirect } from '@/i18n/navigation';
import { oauthAPI } from '@/lib/api';
import { getOAuthStateCookie, removeOAuthStateCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
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
    const targetPath = returnPath || defaultPath;

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

    const storedState = await getOAuthStateCookie();
    if (state && state !== storedState) {
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

    let href: string;
    try {
        await oauthAPI.readPackagesCallback(providerId, code, state || undefined);
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
