import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

const { headersMock, getAuthFromCookieMock, getAuthAccessCookieMock } = vi.hoisted(() => ({
    headersMock: vi.fn(),
    getAuthFromCookieMock: vi.fn(),
    getAuthAccessCookieMock: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: headersMock, cookies: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getAuthFromCookie: getAuthFromCookieMock }));
vi.mock('@/lib/auth/cookies', () => ({ getAuthAccessCookie: getAuthAccessCookieMock }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));

import { GET } from './route';

const params = Promise.resolve({ id: 'w1' });

/**
 * Polled by `ComparisonGenerationProgress`. Same contract as the deploy
 * status route: the scope comes from the browser's per-tab selector, and
 * without it the handler fails closed to its idle payload without calling
 * the platform.
 */
describe('GET /api/works/[id]/comparisons/generation-status workspace scope', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromCookieMock.mockResolvedValue({ id: 'u1' });
        getAuthAccessCookieMock.mockResolvedValue('access-token');
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(JSON.stringify({ generating: true, stage: 'researching' }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }),
            ),
        );
    });

    it('forwards the browser selector to the platform as the API scope header', async () => {
        headersMock.mockResolvedValue(
            new Headers({ host: 'app.example', [BROWSER_WORKSPACE_SCOPE_HEADER]: 'org:ever' }),
        );

        const response = await GET(
            new NextRequest('https://app.example/api/works/w1/comparisons/generation-status'),
            { params },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ generating: true, stage: 'researching' });
        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(String(url)).toMatch(/\/works\/w1\//);
        expect(new Headers(init?.headers).get(API_SCOPE_HEADER)).toBe('ever');
    });

    it('fails closed without a selector: idle payload and no upstream call', async () => {
        headersMock.mockResolvedValue(new Headers({ host: 'app.example' }));

        const response = await GET(
            new NextRequest('https://app.example/api/works/w1/comparisons/generation-status'),
            { params },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ generating: false });
        expect(fetch).not.toHaveBeenCalled();
    });
});
