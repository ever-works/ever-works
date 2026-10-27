import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const cookie = vi.hoisted(() => ({ token: 'fake-jwt' as string | null }));

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => cookie.token),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example/api',
}));

import { GET } from './route';
import { POST as REFRESH } from './refresh/route';
import { POST as LOGS } from '../app-logs/route';
import { GET as READ_LOGS } from '../app-logs/[requestId]/route';
import { POST as RUN_JOB } from '../app-jobs/[name]/run/route';
import { POST as SMOKE } from '../app-smoke/route';
import { GET as HISTORY } from '../app-deployments/route';

/**
 * Lane aw-ops (APW-06 T36) — the App runtime BFF routes. Pinned for every one of them: 401
 * without a session, 400 without the per-tab workspace selector (fail closed — the "BFF route
 * drops workspace scope" class), the Organization scope forwarded as the platform header, the
 * platform's status and body passed through (a 429's `Retry-After` included), and bodies rebuilt
 * from an allow-list.
 */

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const REQUEST_ID = 'b5e1c7a0-3333-4c4d-9e5f-607182930415';

function request(method: 'GET' | 'POST', body?: unknown, selector: string | null = 'org:ever') {
    const headers = new Headers();
    if (selector) headers.set('x-ever-workspace', selector);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return new NextRequest(`http://web.example/api/works/${WORK_ID}/app-status`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

describe('App runtime BFF routes (lane aw-ops)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        cookie.token = 'fake-jwt';
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ state: 'live', stale: false }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    const all = () =>
        [
            ['status', () => GET(request('GET'), ctx({ id: WORK_ID })), 'GET', '/app-status'],
            [
                'refresh',
                () => REFRESH(request('POST'), ctx({ id: WORK_ID })),
                'POST',
                '/app-status/refresh',
            ],
            [
                'logs',
                () => LOGS(request('POST', { component: 'web' }), ctx({ id: WORK_ID })),
                'POST',
                '/app-logs',
            ],
            [
                'read logs',
                () => READ_LOGS(request('GET'), ctx({ id: WORK_ID, requestId: REQUEST_ID })),
                'GET',
                `/app-logs/${REQUEST_ID}`,
            ],
            [
                'run job',
                () =>
                    RUN_JOB(
                        request('POST', { confirmFirstDeploy: true }),
                        ctx({ id: WORK_ID, name: 'migrate' }),
                    ),
                'POST',
                '/app-jobs/migrate/run',
            ],
            ['smoke', () => SMOKE(request('POST'), ctx({ id: WORK_ID })), 'POST', '/app-smoke'],
            [
                'history',
                () => HISTORY(request('GET'), ctx({ id: WORK_ID })),
                'GET',
                '/app-deployments',
            ],
        ] as const;

    it('forwards each call with the session and the Organization scope, to its platform route', async () => {
        for (const [name, run, method, path] of all()) {
            fetchMock.mockClear();
            const response = await run();
            expect([name, response.status]).toEqual([name, 200]);
            const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
            expect([name, url, init.method]).toEqual([
                name,
                `http://api.example/api/works/${WORK_ID}${path}`,
                method,
            ]);
            const headers = new Headers(init.headers);
            expect(headers.get('authorization')).toBe('Bearer fake-jwt');
            expect(headers.get('x-scope-slug')).toBe('ever');
            expect(init.cache).toBe('no-store');
        }
    });

    it('answers 401 without a session and 400 without the workspace selector, calling nothing', async () => {
        cookie.token = null;
        for (const [name, run] of all()) {
            expect([name, (await run()).status]).toEqual([name, 401]);
        }
        cookie.token = 'fake-jwt';
        const noScope = await GET(request('GET', undefined, null), ctx({ id: WORK_ID }));
        expect(noScope.status).toBe(400);
        const noScopeJob = await RUN_JOB(
            request('POST', { confirmFirstDeploy: true }, null),
            ctx({ id: WORK_ID, name: 'migrate' }),
        );
        expect(noScopeJob.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses malformed ids and job names before anything leaves the web tier', async () => {
        expect((await GET(request('GET'), ctx({ id: 'not-a-uuid' }))).status).toBe(400);
        expect(
            (await READ_LOGS(request('GET'), ctx({ id: WORK_ID, requestId: '../x' }))).status,
        ).toBe(400);
        expect(
            (await RUN_JOB(request('POST', {}), ctx({ id: WORK_ID, name: '../../admin' }))).status,
        ).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes the platform’s refusal through, with a 429’s Retry-After', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ status: 'error', code: 'refresh_too_soon', retryAfterSeconds: 9 }),
                {
                    status: 429,
                    headers: { 'content-type': 'application/json', 'retry-after': '9' },
                },
            ),
        );
        const response = await REFRESH(request('POST'), ctx({ id: WORK_ID }));
        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('9');
        await expect(response.json()).resolves.toMatchObject({ code: 'refresh_too_soon' });
    });

    it('rebuilds the log and job bodies from an allow-list', async () => {
        await LOGS(
            request('POST', {
                component: 'web',
                lines: 9000,
                previous: true,
                deploymentId: 'nope',
                secretValues: { A: 'b' },
            }),
            ctx({ id: WORK_ID }),
        );
        const [, logsInit] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(logsInit.body))).toEqual({
            component: 'web',
            lines: 500,
            previous: true,
        });

        fetchMock.mockClear();
        await RUN_JOB(
            request('POST', { confirmFirstDeploy: 'yes', image: 'evil' }),
            ctx({ id: WORK_ID, name: 'seed' }),
        );
        const [, jobInit] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(jobInit.body))).toEqual({});
    });

    it('answers 502 without leaking the platform address when the platform cannot be reached', async () => {
        fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:3100'));
        const response = await GET(request('GET'), ctx({ id: WORK_ID }));
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain('10.0.0.1');
    });
});
