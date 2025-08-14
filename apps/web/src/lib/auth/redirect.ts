import { AuthResponse } from '../api';
import { addSessionTokenToUrl, isValidRedirectUrl } from '../utils';
import { getRedirectCookie, removeRedirectCookie } from './cookies';

export async function getRedirectUrl(authResponse: AuthResponse | null, initialHref: string) {
    const redirectUrl = await getRedirectCookie();

    if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
        await removeRedirectCookie();

        initialHref = authResponse
            ? addSessionTokenToUrl(redirectUrl, authResponse.access_token)
            : redirectUrl;
    }

    return initialHref;
}
