import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { NextRequest, NextResponse } from 'next/server';
import { LOCALES, PUBLIC_ROUTES, ROUTES } from './lib/constants';
import { AUTH_COOKIE_NAME } from './lib/auth/cookies';
import { match } from 'path-to-regexp';
import { getAuthFromCookie } from './lib/auth';

const nextIntlMiddleware = createMiddleware(routing);

// Does this pathname look like a real static asset (so the proxy should
// skip it) rather than an app route?
//
// Historically this was "any path containing a dot" (`pathname.includes('.')`
// + a `.*\..*` matcher). That is correct for every asset the app serves —
// `favicon.ico`, `*.lottie` animations, `manifest.webmanifest`, `*.json`,
// fonts, images — but it ALSO swallowed the one family of app routes that
// legitimately contains a dot: KB document pages use the canonical
// `<class>/<slug>.md` shape (e.g. `/works/<id>/kb/legal/privacy.md`).
// Skipping the proxy for those meant the next-intl locale rewrite never
// ran (under `localePrefix: 'never'`), so client-side <Link> navigation
// into the `/[locale]` tree stalled — the inherited-doc row click in
// kb-inherited.spec.ts never settled on the dotted URL.
//
// So we keep the broad "has a dot → static asset" rule (preserving the
// exact prior behaviour for every real asset, including `.lottie` and
// `.webmanifest`) and carve out ONLY a trailing `.md`, which is always an
// app doc route, never a served static file. This RE is the runtime twin
// of the negative-lookahead in `config.matcher` at the bottom of this
// file — keep the two in lock-step.
function isStaticAssetPath(pathname: string): boolean {
    return pathname.includes('.') && !pathname.endsWith('.md');
}

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

// Security: a CSP source-expression is a scheme/host/port (optionally with a
// leading `*.` subdomain wildcard and a path), e.g. `https://api.tenant.io`.
// `NEXT_PUBLIC_EXTRA_CONNECT_SRC` is operator-supplied but is NOT a secret and
// gets interpolated raw into the `connect-src` directive, so a malformed/abusive
// entry containing CSP delimiters (whitespace, `;`, quotes) could smuggle extra
// directives or `'unsafe-inline'`/`*` into the policy. Accept only well-formed
// host sources and drop anything else; legitimate hostnames pass unchanged.
const SAFE_CSP_HOST_SOURCE = /^(?:https?|wss?):\/\/(?:\*\.)?[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[^\s'";,*]*)?$/;

function buildCsp(): string {
    const extraConnect = (process.env.NEXT_PUBLIC_EXTRA_CONNECT_SRC || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        // Security: reject directive-injection payloads (whitespace/quotes/`;`/
        // bare `*`) — keep only valid scheme+host[:port] connect-src sources.
        .filter((s) => SAFE_CSP_HOST_SOURCE.test(s));
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

    // 1) Legacy `/en/works` → `/works` redirect for old bookmarks.
    //    - `307` (not the cache-eligible `308`): the redirect's correctness
    //      depends on the `Set-Cookie` side-effect firing on the next visit
    //      too, so we must not let browsers / CDNs short-circuit it.
    //    - `Cache-Control: no-store` belt-and-braces against any
    //      intermediary that would still treat the response as cacheable.
    //    - Only seed `NEXT_LOCALE` when the user has NO existing
    //      preference: clicking a shared `/en/...` link should NOT
    //      silently flip an existing French user back to English.
    const legacy = detectLegacyLocalePrefix(pathname);
    if (legacy) {
        const target = new URL(req.url);
        target.pathname = legacy.rest;
        const response = NextResponse.redirect(target, 307);
        response.headers.set('Cache-Control', 'no-store');
        if (!req.cookies.has(NEXT_LOCALE_COOKIE)) {
            response.cookies.set(NEXT_LOCALE_COOKIE, legacy.locale, {
                path: '/',
                sameSite: 'lax',
                maxAge: 60 * 60 * 24 * 365,
            });
        }
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

    // 4) Static assets and API routes pass through. `isStaticAssetPath`
    //    keeps the original "has a dot → static asset" rule but carves out
    //    a trailing `.md`, so dotted app routes like the KB
    //    `<class>/<slug>.md` doc pages still flow through the auth gate
    //    below and the next-intl rewrite above, while real assets
    //    (`.lottie`, `.webmanifest`, images, fonts, …) keep bypassing.
    if (
        pathname.startsWith('/_next') ||
        pathname.startsWith('/api/') ||
        isStaticAssetPath(pathname)
    ) {
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
    // - … any path that contains a dot (a static asset) UNLESS it ends in
    //   `.md` (a KB document app route).
    //
    // The exclusion `.*\.(?!md$)[^/]*$` reads as "a dot whose trailing
    // segment is not exactly `md`" — i.e. every real static asset
    // (`favicon.ico`, `*.lottie`, `manifest.webmanifest`, images, fonts,
    // `.json`, …) is still excluded and bypasses the middleware exactly as
    // before, while the KB doc routes `/works/<id>/kb/<class>/<slug>.md`
    // are NOT excluded so the next-intl locale rewrite runs and client-side
    // navigation to them settles. MUST stay in lock-step with
    // `isStaticAssetPath` at the top of this file (its runtime twin).
    matcher: '/((?!api|trpc|_next|_vercel|.*\\.(?!md$)[^/]*$).*)',
};
