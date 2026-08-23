import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '../workspace-scope';

const { getAuthAccessCookieMock, headersMock, translationsMock } = vi.hoisted(() => ({
    getAuthAccessCookieMock: vi.fn(),
    headersMock: vi.fn(),
    translationsMock: vi.fn(async () => (key: string) => key),
}));

vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('../auth/cookies', () => ({ getAuthAccessCookie: getAuthAccessCookieMock }));
vi.mock('next-intl/server', () => ({ getTranslations: translationsMock }));
vi.mock('../constants', () => ({
    ALLOWED_REDIRECT_URLS: ['app.example'],
    API_URL: 'https://api.example',
    ROUTES: { DASHBOARD: '/' },
    WEB_URL: 'https://app.example',
}));

import { getLoginDefaultWorkspaceHref, serverFetch } from './server-api';

describe('serverFetch workspace scope transport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthAccessCookieMock.mockResolvedValue('access-token');
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(JSON.stringify({ ok: true }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }),
            ),
        );
    });

    it.each([
        ['org:ever', 'ever'],
        ['personal', '@personal'],
    ])('overwrites caller scope from the proxy selector %s', async (selector, expected) => {
        headersMock.mockResolvedValue(
            new Headers({
                host: 'app.example',
                [BROWSER_WORKSPACE_SCOPE_HEADER]: selector,
            }),
        );

        await serverFetch('/me/missions', {
            method: 'POST',
            headers: { [API_SCOPE_HEADER]: 'attacker-yo' },
            body: '{}',
        });

        const init = vi.mocked(fetch).mock.calls[0][1];
        const sent = new Headers(init?.headers);
        expect(sent.get(API_SCOPE_HEADER)).toBe(expected);
        expect(sent.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
    });

    it('fails closed when a server mutation has no trusted proxy selector', async () => {
        headersMock.mockResolvedValue(new Headers({ host: 'app.example' }));

        await expect(serverFetch('/me/missions', { method: 'POST', body: '{}' })).rejects.toThrow(
            'Invalid workspace scope',
        );
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        ['ever', '/org/ever/dashboard'],
        [null, '/'],
    ])(
        'hydrates the fresh-login default %s without changing request authority',
        async (slug, href) => {
            headersMock.mockResolvedValue(
                new Headers({ host: 'app.example', [BROWSER_WORKSPACE_SCOPE_HEADER]: 'personal' }),
            );
            vi.mocked(fetch).mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        tenantId: 'tenant-1',
                        organizationId: slug ? 'org-ever' : null,
                        organizationSlug: slug,
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            );

            await expect(getLoginDefaultWorkspaceHref()).resolves.toBe(href);
        },
    );

    it('does not downgrade a revoked login default to personal', async () => {
        headersMock.mockResolvedValue(
            new Headers({ host: 'app.example', [BROWSER_WORKSPACE_SCOPE_HEADER]: 'personal' }),
        );
        vi.mocked(fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({ message: 'Organization not found' }), {
                status: 404,
                headers: { 'content-type': 'application/json' },
            }),
        );

        await expect(getLoginDefaultWorkspaceHref()).rejects.toMatchObject({ statusCode: 404 });
    });
});
