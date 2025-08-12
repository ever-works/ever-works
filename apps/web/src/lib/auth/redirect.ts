import { AuthResponse } from '../api';
import { addSessionTokenToUrl, isValidRedirectUrl } from '../utils';
import { getRedirectCookie, removeRedirectCookie } from './cookies';

export async function authRedirect(authReponse: AuthResponse | null, initialHref: string) {
    if (!authReponse) {
        return initialHref;
    }

    const redirectUrl = await getRedirectCookie();

    if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
        await removeRedirectCookie();

        initialHref = addSessionTokenToUrl(redirectUrl, authReponse.access_token);
    }

    return initialHref;
}
