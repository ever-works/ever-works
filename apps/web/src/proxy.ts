import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_LOCALE, PUBLIC_ROUTES, REDIRECT_SEARCH_PARAM, ROUTES } from './lib/constants';
import { AUTH_COOKIE_NAME } from './lib/auth/cookies';
import { match } from 'path-to-regexp';
import { getAuthFromCookie } from './lib/auth';

const nextIntlMiddleware = createMiddleware(routing);

function isPublicRoute(pathname: string): boolean {
    return PUBLIC_ROUTES.some((route) => {
        const matcher = match(route);
        return pathname === route || !!matcher(pathname);
    });
}

function redirect(locale: string, to: string, req: NextRequest) {
    const url = locale ? `/${locale}${to}` : to;

    return NextResponse.redirect(new URL(url, req.url));
}

export default async function proxy(req: NextRequest) {
    const originalPathname = req.nextUrl.pathname;

    const intlResponse = await nextIntlMiddleware(req);

    const segments = originalPathname.split('/').filter(Boolean);
    let maybeLocale = segments[0];
    const hasLocale = routing.locales.includes(maybeLocale as any);

    maybeLocale = hasLocale ? maybeLocale : DEFAULT_LOCALE;
    const pathname = hasLocale ? `/${segments.slice(1).join('/')}` : originalPathname;

    // Allow public routes
    if (isPublicRoute(pathname)) {
        return intlResponse;
    }

    // Static assets and API routes should pass through
    if (pathname.startsWith('/_next') || pathname.startsWith('/api/') || pathname.includes('.')) {
        return intlResponse;
    }

    // Check authentication
    const auth = await getAuthFromCookie().catch(() => null);
    if (pathname === '/' || pathname === ROUTES.AUTH_LOGIN) {
        console.log('[auth proxy] request auth check', {
            pathname,
            hasBetterAuthSessionCookie:
                req.cookies.has('better-auth.session_token') ||
                req.cookies.has('__Secure-better-auth.session_token'),
            hasBetterAuthSessionDataCookie:
                req.cookies.has('better-auth.session_data') ||
                req.cookies.has('__Secure-better-auth.session_data'),
            hasLegacyJwtCookie: req.cookies.has(AUTH_COOKIE_NAME),
            isAuthenticated: !!auth,
        });
    }
    if (!auth) {
        // Not authenticated - redirect to login
        const loginUrl = new URL(ROUTES.AUTH_LOGIN, req.url);
        loginUrl.searchParams.set(REDIRECT_SEARCH_PARAM, pathname);

        // Remove invalid cookie if it exists
        if (req.cookies.has(AUTH_COOKIE_NAME)) {
            req.cookies.delete(AUTH_COOKIE_NAME);
        }

        return redirect(maybeLocale, ROUTES.AUTH_LOGIN, req);
    }

    return intlResponse;
}

export const config = {
    // Match all pathnames except for
    // - … if they start with `/api`, `/trpc`, `/_next` or `/_vercel`
    // - … the ones containing a dot (e.g. `favicon.ico`)
    matcher: '/((?!api|trpc|_next|_vercel|.*\\..*).*)',
};
