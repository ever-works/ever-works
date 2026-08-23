import { beforeEach, describe, expect, it, vi } from 'vitest';
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

        expect(response.headers.get('x-middleware-rewrite')).toBe(
            'http://127.0.0.1:3000/en/missions?status=active',
        );
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

        expect(response.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/en/login');
    });

    it.each(['/settings/dashboard', '/org/dashboard'])(
        'does not reinterpret reserved or locale route %s as a legacy Organization',
        async (path) => {
            await proxy(request(path));
            expect(intlMock).toHaveBeenCalledTimes(1);
        },
    );
});
