import { redirect } from '@/i18n/navigation';
import { authAPI, AuthResponse } from '@/lib/api';
import { getOAuthState, setAuthCookie, setRefreshCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
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

    let href = ROUTES.HOME;

    try {
        let authReponse: AuthResponse | null = null;
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
            await Promise.all([
                setAuthCookie(authReponse.access_token),
                setRefreshCookie(authReponse.refresh_token),
            ]);
        }
    } catch (error) {
        href = ROUTES.AUTH_ERROR + '?error=oauth_callback';

        if (error instanceof Error && error.message.includes('suspended')) {
            href = ROUTES.AUTH_ERROR + '?error=account_locked';
        }
    }

    return redirect({ locale, href });
}
