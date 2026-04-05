import { redirect } from '@/i18n/navigation';
import { oauthAPI } from '@/lib/api';
import { getOAuthStateCookie, removeOAuthStateCookie } from '@/lib/auth';
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
        await removeOAuthStateCookie();
        return redirect({
            locale,
            href: ROUTES.AUTH_ERROR + '?error=oauth_invalid_state',
        });
    }

    await removeOAuthStateCookie();

    // Build redirect href — redirect() must be called outside try/catch because
    // next-intl's redirect() throws a NEXT_REDIRECT control flow exception internally.
    let href: string;
    try {
        await oauthAPI.connectCallback(providerId, code, state || undefined);
        const defaultPath = ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('git-provider');
        href = (returnPath || defaultPath) + '?oauth_connected=true';
    } catch (error) {
        console.error(`Failed to connect OAuth provider ${providerId}:`, error);
        href = ROUTES.AUTH_ERROR + '?error=oauth_failed';
    }

    return redirect({ locale, href });
}
