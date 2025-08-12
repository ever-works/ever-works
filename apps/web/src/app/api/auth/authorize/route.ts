import { redirect } from '@/i18n/navigation';
import { getAuthFromRequest, setRedirectCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { addSessionTokenToUrl, isValidRedirectUrl } from '@/lib/utils';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
    const redirectUrl = request.nextUrl.searchParams.get('redirectUrl');
    const locale = await getLocale();

    if (!redirectUrl || !isValidRedirectUrl(redirectUrl)) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=authorize_invalid_redirect_url',
        });
    }

    const auth = await getAuthFromRequest().catch(() => null);

    if (auth?.isAuthenticated && !auth.isExpired) {
        return redirect({
            locale,
            href: addSessionTokenToUrl(redirectUrl, auth.token),
        });
    }

    await setRedirectCookie(redirectUrl);

    return redirect({ locale, href: ROUTES.AUTH_LOGIN });
}
