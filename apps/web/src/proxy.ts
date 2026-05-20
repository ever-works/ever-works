import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_LOCALE, PUBLIC_ROUTES, REDIRECT_SEARCH_PARAM, ROUTES } from './lib/constants';
import { AUTH_COOKIE_NAME } from './lib/auth/cookies';
import { match } from 'path-to-regexp';
import { getAuthFromCookie } from './lib/auth';

const nextIntlMiddleware = createMiddleware(routing);

// Baseline security headers, duplicated from `next.config.ts headers()`
// so they're applied unconditionally — every response the proxy returns
// flows through `applySecurityHeaders` before leaving the function. The
// config-headers path skips some dev-server code paths (the csp-strict
// e2e contract was seeing the CSP header missing on /en/login), this
// proxy-level write is the belt-and-braces guarantee.
const STATIC_SECURITY_HEADERS: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
};

function buildCsp(): string {
    const extraConnect = (process.env.NEXT_PUBLIC_EXTRA_CONNECT_SRC || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://api.ever.works';
    let apiHost: string;
    try {
        apiHost = new URL(apiUrl).origin;
    } catch {
        apiHost = 'https://api.ever.works';
    }
    return [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' https:",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://us.i.posthog.com https://eu.i.posthog.com",
        `connect-src 'self' ${apiHost} https://*.posthog.com https://us.i.posthog.com https://eu.i.posthog.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://api.openai.com https://cdn.jsdelivr.net https://unpkg.com ${extraConnect.join(' ')}`.trim(),
        "worker-src 'self' blob:",
    ].join('; ');
}

const CSP = buildCsp();

function applySecurityHeaders(response: NextResponse): NextResponse {
    for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
        response.headers.set(name, value);
    }
    response.headers.set('Content-Security-Policy', CSP);
    return response;
}

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
        return applySecurityHeaders(intlResponse);
    }

    // Static assets and API routes should pass through
    if (pathname.startsWith('/_next') || pathname.startsWith('/api/') || pathname.includes('.')) {
        return applySecurityHeaders(intlResponse);
    }

    // Check authentication
    const auth = await getAuthFromCookie().catch(() => null);
    if (!auth) {
        const response = redirect(maybeLocale, ROUTES.AUTH_LOGIN, req);

        if (req.cookies.has(AUTH_COOKIE_NAME)) {
            response.cookies.delete(AUTH_COOKIE_NAME);
        }

        return applySecurityHeaders(response);
    }

    return applySecurityHeaders(intlResponse);
}

export const config = {
    // Match all pathnames except for
    // - … if they start with `/api`, `/trpc`, `/_next` or `/_vercel`
    // - … the ones containing a dot (e.g. `favicon.ico`)
    matcher: '/((?!api|trpc|_next|_vercel|.*\\..*).*)',
};
