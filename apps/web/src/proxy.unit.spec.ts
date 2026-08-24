import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from './lib/workspace-scope';

const { getAuthFromRequestMock, intlMock } = vi.hoisted(() => ({
    getAuthFromRequestMock: vi.fn(),
    intlMock: vi.fn(async (_request: unknown) => new Response(null, { status: 200 })),
}));

vi.mock('next-intl/middleware', () => ({ default: () => intlMock }));
vi.mock('./lib/auth', () => ({ getAuthFromRequest: getAuthFromRequestMock }));

import proxy from './proxy';

function request(path: string, selector = 'attacker-supplied'): NextRequest {
    return new NextRequest(`https://app.example${path}`, {
        headers: { [BROWSER_WORKSPACE_SCOPE_HEADER]: selector },
    });
}

describe('canonical Organization workspace proxy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it.each([
        ['/org/ever/missions?status=active', '/missions', 'org:ever'],
        ['/org/en/dashboard', '/', 'org:en'],
        ['/missions', '/missions', 'personal'],
    ])(
        'rewrites %s internally and overwrites the trusted selector',
        async (path, internal, scope) => {
            await proxy(request(path));

            const scopedRequest = intlMock.mock.calls[0][0] as NextRequest;
            expect(scopedRequest.nextUrl.pathname).toBe(internal);
            expect(scopedRequest.nextUrl.search).toBe(path.includes('?') ? '?status=active' : '');
            expect(scopedRequest.headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe(scope);
        },
    );

    it('redirects only an unambiguous legacy Organization dashboard URL', async () => {
        const response = await proxy(request('/ever/dashboard?tab=agents'));

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(
            'https://app.example/org/ever/dashboard?tab=agents',
        );
        expect(intlMock).not.toHaveBeenCalled();
    });

    it('keeps the existing locale compatibility redirect distinct from Organization routing', async () => {
        const response = await proxy(request('/en/dashboard'));

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe('https://app.example/dashboard');
        expect(intlMock).not.toHaveBeenCalled();
    });

    // Was: asserted the rewrite was re-pointed at the request authority. That
    // absolutising is the defect that took production down twice (500, then
    // ERR_TOO_MANY_REDIRECTS); the intent — the rewrite must stay INTERNAL — is
    // now satisfied by emitting a path, which Next cannot treat as external.
    it('keeps next-intl rewrites internal when the runtime request host differs', async () => {
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: {
                    'x-middleware-rewrite': 'http://localhost:3000/en/missions?status=active',
                },
            }),
        );
        const runtimeRequest = new NextRequest(
            'http://localhost:3000/org/ever/missions?status=active',
            {
                headers: {
                    host: '127.0.0.1:3000',
                    [BROWSER_WORKSPACE_SCOPE_HEADER]: 'attacker-supplied',
                },
            },
        );

        const response = await proxy(runtimeRequest);

        expect(response.headers.get('x-middleware-rewrite')).toBe('/en/missions?status=active');
    });

    // Was: asserted the runtime origin (http://$HOSTNAME:$PORT). Measured on the
    // running prod pod, that origin STILL lost Next's internal comparison and
    // produced a 307 loop (#2227). A path wins it unconditionally.
    it('keeps a reverse-proxy locale rewrite internal', async () => {
        vi.stubEnv('HOSTNAME', 'ever-works-web-pod');
        vi.stubEnv('PORT', '3000');
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: { 'x-middleware-rewrite': 'http://localhost:3000/en/login' },
            }),
        );
        const ingressRequest = new NextRequest('https://127.0.0.1:3000/login', {
            headers: {
                host: '127.0.0.1:3000',
                'x-forwarded-host': '127.0.0.1',
                'x-forwarded-proto': 'https',
            },
        });

        const response = await proxy(ingressRequest);

        expect(response.headers.get('x-middleware-rewrite')).toBe('/en/login');
    });

    it('does not align an internal rewrite to a non-allowlisted Host header', async () => {
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: { 'x-middleware-rewrite': 'http://localhost:3000/en/login' },
            }),
        );
        const hostileRequest = new NextRequest('http://localhost:3000/login', {
            headers: { host: 'malicious.invalid' },
        });

        const response = await proxy(hostileRequest);

        // Security intent unchanged and strengthened: a hostile Host header must
        // not steer the rewrite. It no longer CAN — the emitted value carries no
        // authority at all.
        expect(response.headers.get('x-middleware-rewrite')).toBe('/en/login');
    });

    it('ignores an untrusted forwarded authority and falls back to the allowlisted Host', async () => {
        intlMock.mockResolvedValueOnce(
            new Response(null, {
                status: 200,
                headers: { 'x-middleware-rewrite': 'http://localhost:3000/en/login' },
            }),
        );
        const requestWithHostFallback = new NextRequest('http://127.0.0.1:3000/login', {
            headers: {
                host: '127.0.0.1:3000',
                'x-forwarded-host': 'malicious.invalid',
                'x-forwarded-proto': 'javascript',
            },
        });

        const response = await proxy(requestWithHostFallback);

        // Same intent: an untrusted forwarded authority must not steer the
        // rewrite. It cannot — the emitted value is a path with no authority.
        expect(response.headers.get('x-middleware-rewrite')).toBe('/en/login');
    });

    it.each(['/settings/dashboard', '/org/dashboard'])(
        'does not reinterpret reserved or locale route %s as a legacy Organization',
        async (path) => {
            await proxy(request(path));
            expect(intlMock).toHaveBeenCalledTimes(1);
        },
    );
});
