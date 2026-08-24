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
 * 🛑 THIS SUITE CANNOT CATCH THE /login LOCALE-REWRITE DEFECT. Do not treat it
 * as the regression guard for it, and do not add assertions here hoping to.
 *
 * It mocks `next-intl/middleware` wholesale and asserts the header string
 * `proxy()` RETURNS. The defect happens AFTER `proxy()` returns, inside Next's
 * middleware adapter, which reparses `x-middleware-rewrite`:
 *   - an absolute origin that does not match the server's init URL is treated
 *     as an EXTERNAL rewrite -> redirect -> the request re-enters and loops;
 *   - a path-only value is reparsed as `new NextURL(value)` with NO base and
 *     throws `ERR_INVALID_URL` -> HTTP 500.
 * Neither outcome is reachable from this file, because the adapter is mocked away.
 *
 * Concretely: `https://app.ever.works/en/login` is the value `proxy()` returns
 * in the FIXED state AND the value it returned in broken state `14bd578a2`
 * (#2219, ERR_TOO_MANY_REDIRECTS). Identical on both sides, so no assertion on
 * it can discriminate. This suite was green through all five states of an
 * ~8.5 h production outage on 2026-08-24.
 *
 * What it legitimately pins: `proxy()` must not MANGLE the rewrite (that is how
 * #2243/#2244 broke it) and must not introduce a `location` header of its own.
 * That is a narrow, real property — just not the outage guard.
 *
 * THE ACTUAL GUARD is the "Guard: /login renders behind a foreign authority"
 * step in `.github/workflows/ci.yml` (`lint-and-test`), which boots the built
 * artifact and makes one request that CROSSES the adapter boundary. If you are
 * here because that guard went red, the bug is real — do not weaken it here.
 */
describe('proxy delegates ingress locale rewrite normalization to Next', () => {
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

    it('preserves the absolute rewrite next-intl emits behind ingress', async () => {
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

        // OUTCOME at this seam: unmangled passthrough + proxy() added no redirect
        // of its own. Status/redirect behaviour proper is Next's, and is asserted by
        // the CI guard, not here.
        expect(rewrite).toBe('https://app.ever.works/en/login');
        expect(response.headers.get('location')).toBeNull();
        expect(response.status).toBe(200);
    });

    it('preserves the complete rewrite including its query string', async () => {
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: {
                    'x-middleware-rewrite': 'https://app.ever.works/en/missions?status=active',
                },
            }),
        );

        const response = await proxy(ingressRequest('/missions?status=active'));

        expect(response.headers.get('x-middleware-rewrite')).toBe(
            'https://app.ever.works/en/missions?status=active',
        );
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
