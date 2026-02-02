import { redirect } from '@/i18n/navigation';
import { authAPI, AuthResponse } from '@/lib/api';
import { OAuthProvider } from '@/lib/api/enums';
import { getOAuthStateCookie, setAuthCookies } from '@/lib/auth';
import { getRedirectUrl } from '@/lib/auth/redirect';
import { ROUTES } from '@/lib/constants';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';

/**
 * OAuth callback route for user authentication (login/register).
 * This route handles GitHub and Google login only.
 *
 * For git provider connections (repository access), use the separate route:
 * /api/git-providers/[providerId]/callback
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ provider: string }> },
) {
    const { provider } = await params;

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
    await loginOauth(provider as OAuthProvider, code, state || '', locale);
    return;
}

/**
 * Handle OAuth login for authentication.
 * Only supports GitHub and Google for user authentication.
 */
async function loginOauth(provider: OAuthProvider, code: string, state: string, locale: string) {
    let href: string = ROUTES.DASHBOARD;
    let authResponse: AuthResponse | null = null;

    try {
        switch (provider) {
            case OAuthProvider.GITHUB: {
                const response = await authAPI.connectGitHubCallback(code, state || undefined);
                authResponse = response;
                break;
            }
            case OAuthProvider.GOOGLE: {
                const response = await authAPI.connectGoogleCallback(code, state || undefined);
                authResponse = response;
                break;
            }
            default:
                href = ROUTES.AUTH_ERROR + '?error=oauth_unsupported_provider';
                break;
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
