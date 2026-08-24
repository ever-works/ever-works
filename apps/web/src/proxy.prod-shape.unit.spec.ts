import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getAuthFromRequestMock, intlMock } = vi.hoisted(() => ({
    getAuthFromRequestMock: vi.fn(),
    intlMock: vi.fn(async (_request: unknown) => new Response(null, { status: 200 })),
}));

vi.mock('next-intl/middleware', () => ({ default: () => intlMock }));
vi.mock('./lib/auth', () => ({ getAuthFromRequest: getAuthFromRequestMock }));
// `ALLOWED_REDIRECT_URLS` is frozen into a const at module load, so stubbing the
// env var after import is a no-op — mock the module to model the deployed value.
vi.mock('./lib/constants', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./lib/constants')>()),
    ALLOWED_REDIRECT_URLS: ['app.ever.works'],
}));

import proxy from './proxy';

/**
 * The locale rewrite must reach Next as a PATH, never as an absolute URL.
 *
 * Next treats an absolute `x-middleware-rewrite` as internal only when its
 * origin matches the server's init URL. Behind ingress, next-intl derives its
 * rewrite from `req.nextUrl.origin` — the PUBLIC authority — so it emits an
 * absolute URL, Next answers with a redirect instead of rendering, and the
 * redirect re-enters this middleware and loops.
 *
 * Three fixes changed WHICH origin was emitted and all three failed in
 * production, because any absolute origin loses that comparison:
 *   7e1f58a44 (#2152)  public authority + :3000  -> undialable -> HTTP 500
 *   14bd578a2 (#2219)  public authority          -> ERR_TOO_MANY_REDIRECTS
 *   57d44302e (#2227)  http://$HOSTNAME:$PORT    -> still looping
 *   #2243              early-return if relative  -> never fired; behind ingress
 *                                                   the rewrite is ALREADY absolute
 *
 * Measured on the running prod pod carrying the #2243 image, same pod:
 *   GET /login  (bare)             -> 200, rewrite '/en/login'
 *   GET /login  + X-Forwarded-Host -> 307 'location: /login',
 *                                     rewrite 'http://<pod>:3000/en/login'
 *
 * The first case below is the one that matters: it feeds the middleware the
 * ABSOLUTE rewrite next-intl really emits behind ingress and asserts a bare
 * path comes out. No previous test modelled that input, which is why three
 * fixes shipped green while production stayed broken.
 */
describe('ingress locale rewrite reaches Next as a path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
        vi.stubEnv('HOSTNAME', 'ever-works-web-767565cfbc-qr6rv');
        vi.stubEnv('PORT', '3000');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    function ingressRequest(path = '/login') {
        return new NextRequest(`https://app.ever.works${path}`, {
            headers: {
                host: 'app.ever.works',
                'x-forwarded-host': 'app.ever.works',
                'x-forwarded-proto': 'https',
            },
        });
    }

    it('strips the origin from the absolute rewrite next-intl emits behind ingress', async () => {
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                // Exactly what next-intl produces when req.nextUrl.origin is the
                // public authority — i.e. every request arriving via ingress.
                headers: { 'x-middleware-rewrite': 'https://app.ever.works/en/login' },
            }),
        );

        const response = await proxy(ingressRequest());
        const rewrite = response.headers.get('x-middleware-rewrite');

        expect(rewrite).toBe('/en/login');
        // Belt and braces: no scheme, no authority, in any form.
        expect(rewrite).not.toMatch(/^[a-z]+:\/\//i);
    });

    it('preserves the query string when stripping the origin', async () => {
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: {
                    'x-middleware-rewrite': 'https://app.ever.works/en/missions?status=active',
                },
            }),
        );

        const response = await proxy(ingressRequest('/missions?status=active'));

        expect(response.headers.get('x-middleware-rewrite')).toBe('/en/missions?status=active');
    });

    it('leaves an already-relative rewrite exactly as emitted', async () => {
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: { 'x-middleware-rewrite': '/en/login' },
            }),
        );

        const response = await proxy(ingressRequest());

        expect(response.headers.get('x-middleware-rewrite')).toBe('/en/login');
    });

    it('does not touch a rewrite whose first segment is not a locale', async () => {
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: { 'x-middleware-rewrite': 'https://app.ever.works/api/health' },
            }),
        );

        const response = await proxy(ingressRequest());

        expect(response.headers.get('x-middleware-rewrite')).toBe(
            'https://app.ever.works/api/health',
        );
    });
});
