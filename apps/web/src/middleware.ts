import { NextResponse, type NextRequest } from 'next/server';

// Top-level Next.js middleware — runs before every request and applies
// the baseline security headers explicitly. We already declare these in
// `next.config.ts headers()`, but some dev-server code paths skip the
// config-based headers (the csp-strict e2e contract was seeing the
// CSP header missing on /en/login). Running the same set through the
// edge middleware is the belt-and-braces guarantee that every response
// — both pages and route handlers — carries the headers.
//
// `next-intl` does its own routing inside the page tree; we don't
// interpose on it here so locale negotiation stays unchanged.

const SECURITY_HEADERS: Record<string, string> = {
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

export function middleware(_request: NextRequest) {
    const response = NextResponse.next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        response.headers.set(name, value);
    }
    response.headers.set('Content-Security-Policy', CSP);
    return response;
}

// Skip Next's internal static + image routes (they're served by the
// framework with its own caching headers and adding CSP to them
// produces no net win). Everything else — pages, API route handlers,
// favicons — gets the headers.
export const config = {
    matcher: ['/((?!_next/static|_next/image).*)'],
};
