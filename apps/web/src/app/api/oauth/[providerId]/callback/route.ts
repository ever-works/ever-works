import { redirect } from '@/i18n/navigation';
import { authAPI, AuthResponse } from '@/lib/api';
import { OAuthProvider } from '@/lib/api/enums';
import { getOAuthStateCookie, setAuthCookies } from '@/lib/auth';
import { getRedirectUrl } from '@/lib/auth/redirect';
import { ROUTES, routeWithParams, withAppUrl } from '@/lib/constants';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';

/**
 * OAuth callback route for user authentication (login/register).
 * This route handles all supported social login providers.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ providerId: string }> },
) {
    const { providerId } = await params;

    const queryParams = request.nextUrl.searchParams;
    const code = queryParams.get('code');
    const state = queryParams.get('state');

    const locale = await getLocale();

    if (!code) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_missing_code',
        });
    }

    const storedState = await getOAuthStateCookie();
    if (state !== storedState) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_invalid_state',
        });
    }

    // Handle authentication OAuth (login/register)
    await loginOauth(providerId as OAuthProvider, code, locale);
    return;
}

/**
 * Handle OAuth login for authentication.
 * Supports all configured social login providers.
 */
async function loginOauth(provider: OAuthProvider, code: string, locale: string) {
    let href: string = ROUTES.DASHBOARD;
    let authResponse: AuthResponse | null = null;

    try {
        if (!Object.values(OAuthProvider).includes(provider)) {
            href = ROUTES.AUTH_ERROR + '?error=oauth_unsupported_provider';
        } else {
            const callbackUrl = withAppUrl(
                routeWithParams(ROUTES.API_OAUTH_CALLBACK, { providerId: provider }),
            );
            authResponse = await authAPI.connectOAuthCallback(provider, code, callbackUrl);
        }

        if (authResponse) {
            await setAuthCookies(authResponse.access_token, authResponse.refresh_token);
        }
    } catch (error) {
        href = ROUTES.AUTH_ERROR + '?error=oauth_callback';

        if (error instanceof Error && error.message.includes('suspended')) {
            href = ROUTES.AUTH_ERROR + '?error=account_locked';
        }
    }

    href = await getRedirectUrl(authResponse, href);

    return redirect({ locale, href });
}
