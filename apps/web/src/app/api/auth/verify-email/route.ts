import { redirect } from '@/i18n/navigation';
import { authAPI } from '@/lib/api';
import { setAuthCookie, setRefreshCookie } from '@/lib/auth';
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

    try {
        const response = await authAPI.verifyEmail({ token });

        await Promise.all([
            setAuthCookie(response.access_token),
            setRefreshCookie(response.refresh_token),
        ]);

        return redirect({
            locale,
            href: ROUTES.HOME + '?verified=true',
        });
    } catch (error) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=verify_email_invalid_token',
        });
    }
}
