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

        expect(rewrite).toBe('https://app.ever.works/en/login');
        expect(response.headers.get('location')).toBeNull();
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
