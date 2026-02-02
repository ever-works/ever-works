import { redirect } from '@/i18n/navigation';
import { gitProvidersAPI } from '@/lib/api';
import { getOAuthStateCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';

/**
 * OAuth callback route for git provider connections.
 * This is separate from the auth callback route (/api/auth/[provider]/callback)
 * which handles user authentication (login/register).
 *
 * This route handles git provider OAuth connections for repository access.
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

    const locale = await getLocale();

    if (!code) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_missing_code',
        });
    }

    // Verify state if provided
    const storedState = await getOAuthStateCookie();
    if (state && state !== storedState) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_invalid_state',
        });
    }

    try {
        // Call the backend to handle the OAuth callback
        await gitProvidersAPI.connectCallback(providerId, code, state || undefined);

        // Redirect to the return path or dashboard with success indicator
        const href =
            (returnPath || ROUTES.DASHBOARD_SETTINGS_GIT_PROVIDERS) +
            '?git_provider_connected=true';
        return redirect({ locale, href });
    } catch (error) {
        console.error(`Failed to connect git provider ${providerId}:`, error);
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=git_provider_oauth_failed',
        });
    }
}
