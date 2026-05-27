import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { NextRequest, NextResponse } from 'next/server';
import { LOCALES, PUBLIC_ROUTES, ROUTES } from './lib/constants';
import { AUTH_COOKIE_NAME } from './lib/auth/cookies';
import { match } from 'path-to-regexp';
import { getAuthFromCookie } from './lib/auth';

const nextIntlMiddleware = createMiddleware(routing);

// next-intl persists the active locale in this cookie when `localePrefix:
// 'never'` is set. We read/write it directly when redirecting legacy
// `/<locale>/...` URLs so the user keeps the language they were using.
const NEXT_LOCALE_COOKIE = 'NEXT_LOCALE';
const LOCALE_SET = new Set<string>(LOCALES);

// Baseline security headers, duplicated from `next.config.ts headers()`
// so they're applied unconditionally — every response the proxy returns
// flows through `applySecurityHeaders` before leaving the function. The
// config-headers path skips some dev-server code paths (the csp-strict
// e2e contract was seeing the CSP header missing on /login), this
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

/**
 * Strip a legacy `/<locale>/...` prefix from a pathname.
 *
 * Until 2026-05 the app served every route under `/<locale>/...` (default
 * `localePrefix: 'always'`). The platform is a SaaS app behind auth, so
 * those URLs leaked the user's UI language into every shareable link.
 * We switched to `localePrefix: 'never'` and the locale now lives in the
 * `NEXT_LOCALE` cookie — but existing bookmarks (`/en/works`,
 * `/fr/dashboard`, …) still hit the app. Redirect them to the
 * unprefixed equivalent and seed the cookie so the user keeps the
 * language they had.
 *
 * Returns `null` when the path has no locale segment.
 */
function detectLegacyLocalePrefix(pathname: string): { locale: string; rest: string } | null {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;

    const first = segments[0];
    if (!LOCALE_SET.has(first)) return null;

    const rest = '/' + segments.slice(1).join('/');
    return { locale: first, rest: rest === '/' ? '/' : rest };
}

export default async function proxy(req: NextRequest) {
    const pathname = req.nextUrl.pathname;

    // 1) Legacy `/en/works` → `/works` (308 — preserves method + body, and
    //    is cacheable). Set NEXT_LOCALE so the user keeps the same
    //    language without an extra round-trip.
    const legacy = detectLegacyLocalePrefix(pathname);
    if (legacy) {
        const target = new URL(req.url);
        target.pathname = legacy.rest;
        const response = NextResponse.redirect(target, 308);
        response.cookies.set(NEXT_LOCALE_COOKIE, legacy.locale, {
            path: '/',
            sameSite: 'lax',
            maxAge: 60 * 60 * 24 * 365,
        });
        return applySecurityHeaders(response);
    }

    // 2) Let next-intl resolve the locale from the cookie / Accept-Language.
    //    In `localePrefix: 'never'` mode this rewrites the request
    //    internally (the visible URL stays unprefixed).
    const intlResponse = await nextIntlMiddleware(req);

    // 3) Public routes need no auth check.
    if (isPublicRoute(pathname)) {
        return applySecurityHeaders(intlResponse);
    }

    // 4) Static assets and API routes pass through.
    if (pathname.startsWith('/_next') || pathname.startsWith('/api/') || pathname.includes('.')) {
        return applySecurityHeaders(intlResponse);
    }

    // 5) Auth gate — unauthenticated users go to /login (no locale prefix).
    const auth = await getAuthFromCookie().catch(() => null);
    if (!auth) {
        const loginUrl = new URL(ROUTES.AUTH_LOGIN, req.url);
        const response = NextResponse.redirect(loginUrl);

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
