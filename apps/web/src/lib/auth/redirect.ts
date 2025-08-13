import { AuthResponse } from '../api';
import { addSessionTokenToUrl, isValidRedirectUrl } from '../utils';
import { getRedirectCookie, removeRedirectCookie } from './cookies';

export async function getRedirectUrl(authReponse: AuthResponse | null, initialHref: string) {
    const redirectUrl = await getRedirectCookie();

    if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
        await removeRedirectCookie();

        initialHref = authReponse
            ? addSessionTokenToUrl(redirectUrl, authReponse.access_token)
            : redirectUrl;
    }

    return initialHref;
}
