import { redirect } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
    const token = request.nextUrl.searchParams.get('token');
    const locale = await getLocale();

    if (!token) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=reset_password_missing_token',
        });
    }

    return redirect({
        locale,
        href: ROUTES.AUTH_RESET_PASSWORD + `?token=${token}`,
    });
}
