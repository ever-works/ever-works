import { redirect } from '@/i18n/navigation';
import { authAPI, AuthResponse } from '@/lib/api';
import { OAuthProvider } from '@/lib/api/enums';
import { getOAuthStateCookie, removeOAuthStateCookie, setAuthCookies } from '@/lib/auth';
import { getRedirectUrl } from '@/lib/auth/redirect';
import { ROUTES } from '@/lib/constants';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';
import {
    addConnectGithubParam,
    isDashboardHref,
    shouldPromptGithubConnect,
} from '@/lib/auth/github-connect';
import { getOAuthRouteErrorCode } from './callback-errors';

export async function handleOAuthCallback(request: NextRequest, providerId: string) {
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
        await removeOAuthStateCookie();
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_invalid_state',
        });
    }

    await removeOAuthStateCookie();

    return loginOauth(request, providerId as OAuthProvider, code, locale);
}

async function loginOauth(
    request: NextRequest,
    provider: OAuthProvider,
    code: string,
    locale: string,
) {
    let href: string = ROUTES.DASHBOARD;
    let authResponse: AuthResponse | null = null;

    try {
        if (!Object.values(OAuthProvider).includes(provider)) {
            href = ROUTES.AUTH_ERROR + '?error=oauth_unsupported_provider';
        } else {
            authResponse = await authAPI.connectOAuthCallback(provider, code);
        }

        if (authResponse) {
            await setAuthCookies(authResponse.access_token);
        }
    } catch (error) {
        const errorCode = getOAuthRouteErrorCode(error, 'oauth_callback');
        href = ROUTES.AUTH_ERROR + `?error=${errorCode}`;
    }

    href = await getRedirectUrl(authResponse, href);

    if (
        authResponse &&
        provider !== OAuthProvider.GITHUB &&
        isDashboardHref(href) &&
        (await shouldPromptGithubConnect(authResponse.access_token))
    ) {
        href = addConnectGithubParam(href);
    }

    return redirect({ locale, href });
}
