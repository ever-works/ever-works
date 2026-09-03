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
 * Polled by `DeployProgressPanel`. The handler reaches the platform through
 * `serverFetch`, so the scope it forwards is the browser's per-tab
 * `x-ever-workspace` selector, and it fails closed (generic 500, no upstream
 * call) when that selector is absent. The client poller is what has to send
 * it; this pins both halves of that contract.
 */
describe('GET /api/works/[id]/deploy/status workspace scope', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromCookieMock.mockResolvedValue({ id: 'u1' });
        getAuthAccessCookieMock.mockResolvedValue('access-token');
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({
                            work: {
                                deploymentState: 'BUILDING',
                                deploymentStartedAt: null,
                                website: null,
                                deployProvider: 'k8s',
                            },
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    ),
            ),
        );
    });

    it('forwards the browser selector to the platform as the API scope header', async () => {
        headersMock.mockResolvedValue(
            new Headers({ host: 'app.example', [BROWSER_WORKSPACE_SCOPE_HEADER]: 'org:ever' }),
        );

        const response = await GET(
            new NextRequest('https://app.example/api/works/w1/deploy/status'),
            { params },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ deploymentState: 'BUILDING' });
        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(String(url)).toMatch(/\/works\/w1$/);
        expect(new Headers(init?.headers).get(API_SCOPE_HEADER)).toBe('ever');
    });

    it('fails closed without a selector: generic 500 and no upstream call', async () => {
        headersMock.mockResolvedValue(new Headers({ host: 'app.example' }));

        const response = await GET(
            new NextRequest('https://app.example/api/works/w1/deploy/status'),
            { params },
        );

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'failed_to_load_deploy_status' });
        expect(fetch).not.toHaveBeenCalled();
    });
});
