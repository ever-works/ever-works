import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

/**
 * @type any
 */
let BUILD_OUTPUT = process.env.NEXT_BUILD_OUTPUT;
BUILD_OUTPUT = ['standalone', 'export'].includes(BUILD_OUTPUT as any) ? BUILD_OUTPUT : undefined;

const withNextIntl = createNextIntlPlugin();

/**
 * M-15 / M-16: baseline security headers for the Next.js web app.
 *
 * The CSP intentionally allows `'unsafe-inline'` for `script-src` because
 * Next.js's runtime emits inline scripts (notably for hydration). Tightening
 * to nonce-based CSP requires plumbing nonces through the request → response
 * pipeline in middleware; queued for a follow-up. The current value still
 * blocks unsanctioned third-party scripts and is materially stricter than
 * "no CSP at all".
 *
 * `connect-src` allow-list is sized for the live integrations: the platform's
 * own API, PostHog telemetry, Sentry ingest, and the Trigger.dev dashboard
 * endpoints. Add hosts via `NEXT_PUBLIC_EXTRA_CONNECT_SRC` (comma-sep) for
 * tenant-specific integrations without redeploying.
 */
const extraConnect = (process.env.NEXT_PUBLIC_EXTRA_CONNECT_SRC || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://api.ever.works';
const apiHost = (() => {
    try {
        return new URL(apiUrl).origin;
    } catch {
        return 'https://api.ever.works';
    }
})();
const CSP = [
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
    // dotlottie-web fetches its WASM blob from jsdelivr (primary) or unpkg
    // (backup). Both are essential for the on-page Lottie animations that
    // boot on /login and /register; without them the E2E suite trips on
    // console errors. Keep them tightly listed (not wildcard).
    `connect-src 'self' ${apiHost} https://*.posthog.com https://us.i.posthog.com https://eu.i.posthog.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://api.openai.com https://cdn.jsdelivr.net https://unpkg.com ${extraConnect.join(' ')}`.trim(),
    "worker-src 'self' blob:",
].join('; ');

const securityHeaders = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    },
    // HSTS: 6 months + subdomains. preload requires submission to
    // https://hstspreload.org/ — leave that opt-in.
    {
        key: 'Strict-Transport-Security',
        value: 'max-age=15552000; includeSubDomains',
    },
    {
        key: 'Content-Security-Policy',
        value: CSP,
    },
];

const nextConfig: NextConfig = {
    output: BUILD_OUTPUT as NextConfig['output'],
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'github.com',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'lh3.googleusercontent.com',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'avatars.githubusercontent.com',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'opengraph.githubassets.com',
                port: '',
                pathname: '/**',
            },
        ],
    },
    async headers() {
        return [
            {
                // Apply to every route except Next's internal API + static assets
                // (those are served by the framework with its own headers).
                source: '/:path*',
                headers: securityHeaders,
            },
        ];
    },
};

export default withNextIntl(nextConfig);
