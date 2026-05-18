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

    // C-03: require state to be present AND match the cookie. The previous
    // `if (state !== storedState)` shape already rejected empty state (since
    // `null !== "ABC"`), but spell it out so a future refactor can't soften
    // it to a conditional `if (state && …)` like the plugin callbacks used
    // to have.
    const storedState = await getOAuthStateCookie();
    if (!state || state !== storedState) {
        await removeOAuthStateCookie();
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_invalid_state',
        });
    }

    await removeOAuthStateCookie();

    // Forward the validated state to the API exchange call so its own C-03
    // check (`OAuthController.authRedirect`) succeeds — the API expects
    // `?state=` query + matching `ew_oauth_state` cookie, and the web's
    // server-to-server fetch synthesizes both from the same validated value.
    return loginOauth(request, providerId as OAuthProvider, code, state, locale);
}

async function loginOauth(
    request: NextRequest,
    provider: OAuthProvider,
    code: string,
    state: string,
    locale: string,
) {
    let href: string = ROUTES.DASHBOARD;
    let authResponse: AuthResponse | null = null;

    try {
        if (!Object.values(OAuthProvider).includes(provider)) {
            href = ROUTES.AUTH_ERROR + '?error=oauth_unsupported_provider';
        } else {
            authResponse = await authAPI.connectOAuthCallback(provider, code, state);
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
