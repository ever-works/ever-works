import { redirect } from '@/i18n/navigation';
import { oauthAPI } from '@/lib/api';
import { getOAuthStateCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { getLocale } from 'next-intl/server';
import { NextRequest } from 'next/server';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ providerId: string }> },
) {
    const { providerId } = await params;
    const queryParams = request.nextUrl.searchParams;
    const code = queryParams.get('code');
    const state = queryParams.get('state');
    const returnPath = queryParams.get('returnPath');

    const locale = await getLocale();

    if (!code) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_missing_code',
        });
    }

    const storedState = await getOAuthStateCookie();
    if (state && state !== storedState) {
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_invalid_state',
        });
    }

    try {
        await oauthAPI.connectCallback(providerId, code, state || undefined);
        // If returnPath is provided, use it; otherwise redirect to plugin settings page
        const defaultPath = ROUTES.DASHBOARD_SETTINGS_PLUGIN('git-provider', providerId);
        const href = (returnPath || defaultPath) + '?oauth_connected=true';
        return redirect({ locale, href });
    } catch (error) {
        console.error(`Failed to connect OAuth provider ${providerId}:`, error);
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_failed',
        });
    }
}
