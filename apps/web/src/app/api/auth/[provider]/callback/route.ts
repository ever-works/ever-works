import { redirect } from '@/i18n/navigation';
import { authAPI, AuthResponse, ConnectionInfo } from '@/lib/api';
import { OAuthProcessType, OAuthProvider } from '@/lib/api/enums';
import { getOAuthStateCookie, setAuthCookies } from '@/lib/auth';
import { getRedirectUrl } from '@/lib/auth/redirect';
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
    const returnPath = queryParams.get('returnPath');
    const process = queryParams.get('process') as OAuthProcessType | undefined;

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

    // Login process
    if (process === 'login' || !process) {
        await loginOauth(provider as OAuthProvider, code, state || '', locale);
        return;
    }

    // Connection process
    await connectOauth(provider as OAuthProvider, returnPath, code, state || '', locale);
    return;
}

async function connectOauth(
    provider: OAuthProvider,
    returnPath: string | null,
    code: string,
    state: string,
    locale: string,
) {
    let href: string = returnPath || ROUTES.DASHBOARD;
    let connectionResponse: ConnectionInfo | null = null;

    try {
        switch (provider) {
            case OAuthProvider.GITHUB: {
                const response = await authAPI.oauth_connections.connectCallback(
                    OAuthProvider.GITHUB,
                    code,
                    state || undefined,
                );
                connectionResponse = response;
                break;
            }
        }
    } catch (error) {
        href = ROUTES.AUTH_ERROR + '?error=oauth_callback';
    }

    return redirect({ locale, href: href + '?oauth_connected=true' });
}

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
