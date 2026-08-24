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
 * next-intl emits a RELATIVE `x-middleware-rewrite` in the deployed app, and a
 * relative rewrite is internal by construction. Absolutising it is what caused
 * both production outages on 2026-08-23/24 — first as a 500 (public authority
 * plus port 3000, undialable), then as ERR_TOO_MANY_REDIRECTS once the port was
 * dropped, and STILL as a redirect when the runtime origin was pinned instead.
 *
 * Measured on the running prod pod, same build, same pod:
 *   GET /login  (bare)             -> 200, rewrite '/en/login'
 *   GET /login  + X-Forwarded-Host -> 307 'location: /login',
 *                                     rewrite 'http://<pod>:3000/en/login'
 *
 * So the invariant is not "which origin" — it is "do not add one".
 */
describe('ingress locale rewrite must stay relative', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    function ingressRequest() {
        return new NextRequest('https://app.ever.works/login', {
            headers: {
                host: 'app.ever.works',
                'x-forwarded-host': 'app.ever.works',
                'x-forwarded-proto': 'https',
            },
        });
    }

    it('leaves a relative rewrite untouched behind ingress', async () => {
        vi.stubEnv('HOSTNAME', 'ever-works-web-6bc7f79765-7hvpd');
        vi.stubEnv('PORT', '3000');
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: { 'x-middleware-rewrite': '/en/login' },
            }),
        );

        const response = await proxy(ingressRequest());

        // Any absolute origin — public OR runtime — makes Next treat the
        // rewrite as external and answer with a redirect, which loops.
        expect(response.headers.get('x-middleware-rewrite')).toBe('/en/login');
    });

    it('still realigns an already-absolute rewrite (the reverse-proxy case)', async () => {
        vi.stubEnv('HOSTNAME', 'ever-works-web-pod');
        vi.stubEnv('PORT', '3000');
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: { 'x-middleware-rewrite': 'http://localhost:3000/en/login' },
            }),
        );

        const response = await proxy(ingressRequest());

        expect(response.headers.get('x-middleware-rewrite')).toBe(
            'http://ever-works-web-pod:3000/en/login',
        );
    });
});
