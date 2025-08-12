import { redirect } from '@/i18n/navigation';
import { authAPI, AuthResponse } from '@/lib/api';
import { setAuthCookies } from '@/lib/auth';
import { getRedirectUrl } from '@/lib/auth/redirect';
import { ROUTES } from '@/lib/constants';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
    const token = request.nextUrl.searchParams.get('token');
    const locale = await getLocale();

    if (!token) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=verify_email_missing_token',
        });
    }

    let href = ROUTES.HOME + '?verified=true';
    let authReponse: AuthResponse | null = null;

    try {
        authReponse = await authAPI.verifyEmail({ token });

        await setAuthCookies(authReponse.access_token, authReponse.refresh_token);
    } catch (error) {
        href = ROUTES.AUTH_ERROR + '?error=verify_email_invalid_token';
    }

    href = await getRedirectUrl(authReponse, href);

    return redirect({ locale, href });
}
