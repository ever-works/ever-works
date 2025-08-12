import { redirect } from '@/i18n/navigation';
import { authAPI, AuthResponse } from '@/lib/api';
import { getOAuthState, getRedirectCookie, removeRedirectCookie, setAuthCookies } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { addSessionTokenToUrl, isValidRedirectUrl } from '@/lib/utils';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';

// For oAuth connection check file:
// Check apps/web/src/app/actions/auth.ts

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

    const storedState = await getOAuthState();
    if (state !== storedState) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_invalid_state',
        });
    }

    let href: string = ROUTES.HOME;
    let authReponse: AuthResponse | null = null;

    try {
        switch (provider) {
            case 'github': {
                const response = await authAPI.connectGitHubCallback(code, state || undefined);
                authReponse = response;
                break;
            }
            case 'google': {
                const response = await authAPI.connectGoogleCallback(code, state || undefined);
                authReponse = response;
                break;
            }
            default:
                href = ROUTES.AUTH_ERROR + '?error=oauth_unsupported_provider';
                break;
        }

        if (authReponse) {
            await setAuthCookies(authReponse.access_token, authReponse.refresh_token);
        }
    } catch (error) {
        href = ROUTES.AUTH_ERROR + '?error=oauth_callback';

        if (error instanceof Error && error.message.includes('suspended')) {
            href = ROUTES.AUTH_ERROR + '?error=account_locked';
        }
    }

    if (authReponse) {
        // Check if we have a redirect URL
        const redirectUrl = await getRedirectCookie();

        if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
            await removeRedirectCookie();
            href = addSessionTokenToUrl(redirectUrl, authReponse.access_token);
        }
    }

    return redirect({ locale, href });
}
