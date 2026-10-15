import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Prod 2026-10-09 — GitHub App install flow. Every local redirect here was
 * built with `new URL(path, request.url)`, and inside the Next server
 * `request.url` is the pod's own bind address (`https://<pod-name>:3000`), so a
 * refused setup sent the browser to an unresolvable host. Requests below are
 * addressed to that INTERNAL origin, exactly as Next hands them over in prod.
 */

import { GET } from './route';

const INTERNAL_ORIGIN = 'https://ever-works-web-7c47bf599d-dc74b:3000';
const PUBLIC_ORIGIN = 'https://app.ever.works';

function setupRequest(query = 'installation_id=169597044&setup_action=install'): NextRequest {
    return new NextRequest(`${INTERNAL_ORIGIN}/api/github-app/setup?${query}`);
}

function apiAnswers(body: unknown, status = 200) {
    const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json' },
            }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function locationOf(response: Response): URL {
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    return new URL(location as string);
}

describe('GET /api/github-app/setup', () => {
    beforeEach(() => {
        vi.stubEnv('NEXT_PUBLIC_WEB_URL', PUBLIC_ORIGIN);
        vi.stubEnv('WEB_URL', PUBLIC_ORIGIN);
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('sends the browser on to the GitHub authorize URL the API returned', async () => {
        const authorize =
            'https://github.com/login/oauth/authorize?client_id=Iv23&state=s1gned&redirect_uri=x';
        const fetchMock = apiAnswers({ url: authorize });

        const url = locationOf(await GET(setupRequest()));

        expect(url.toString()).toBe(authorize);
        const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
        expect(calledUrl.pathname).toMatch(/\/github-app\/setup$/);
        expect(calledUrl.searchParams.get('installation_id')).toBe('169597044');
        expect(calledUrl.searchParams.get('setup_action')).toBe('install');
    });

    describe('every error redirect lands on the PUBLIC origin, never the internal pod host', () => {
        it.each([
            ['API refusal', () => apiAnswers({ message: 'boom' }, 502)],
            ['API answer without url', () => apiAnswers({})],
            ['unparseable url', () => apiAnswers({ url: 'not a url' })],
            ['non-https url', () => apiAnswers({ url: 'http://github.com/login/oauth/authorize' })],
            [
                'foreign host (open-redirect guard)',
                () => apiAnswers({ url: 'https://evil.example/login/oauth/authorize' }),
            ],
            [
                'look-alike host (open-redirect guard)',
                () => apiAnswers({ url: 'https://github.com.evil.example/login' }),
            ],
        ])('%s -> public /auth/error', async (_label, arrange) => {
            arrange();

            const url = locationOf(await GET(setupRequest()));

            expect(url.origin).toBe(PUBLIC_ORIGIN);
            expect(url.pathname).toBe('/auth/error');
            expect(url.searchParams.get('error')).toBe('oauth_callback');
        });
    });
});
