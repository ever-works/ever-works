import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

const cookie = vi.hoisted(() => ({ token: 'fake-jwt' as string | null }));

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => cookie.token),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET as listFacts, POST as createFact } from './route';
import { GET as getStats } from './stats/route';
import { POST as forgetAll } from './forget-all/route';
import { PATCH as updateFact } from './[id]/route';
import { POST as forgetFact } from './[id]/forget/route';
import { POST as restoreFact } from './[id]/restore/route';
import { POST as acceptFact } from './[id]/accept/route';
import { POST as discardFact } from './[id]/discard/route';

/**
 * AW-07 — the `/api/memory/facts` BFF routes.
 *
 * Every fact belongs to one workspace, so every route here is scoped: the
 * browser's per-tab selector must become `X-Scope-Slug`, a browser-supplied
 * `X-Scope-Slug` must never pass through, and a missing selector must fail
 * closed BEFORE anything reaches the API — an unscoped write would file an
 * Organization's fact under the person's personal workspace.
 *
 * `x-scope-slug` is pre-set on every request so each case also proves the
 * spoofed value is overwritten.
 */
function request(
    path: string,
    { method = 'GET', selector, body }: { method?: string; selector?: string; body?: string } = {},
): NextRequest {
    const headers = new Headers({ [API_SCOPE_HEADER]: 'attacker-supplied-org' });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest(`http://web.example${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
    });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('/api/memory/facts BFF routes', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        cookie.token = 'fake-jwt';
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ ok: true }), {
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

    function upstream(call = 0): { url: string; init: RequestInit; headers: Headers } {
        const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
        return { url: String(url), init, headers: new Headers(init.headers) };
    }

    const cases: Array<{
        name: string;
        invoke: (selector?: string) => Promise<Response>;
        url: string;
        method: string;
        body?: string;
    }> = [
        {
            name: 'GET /facts (search)',
            invoke: (selector) =>
                listFacts(request('/api/memory/facts?q=delivery&status=active', { selector })),
            url: 'http://api.example/memory/facts?q=delivery&status=active',
            method: 'GET',
        },
        {
            name: 'POST /facts',
            invoke: (selector) =>
                createFact(
                    request('/api/memory/facts', {
                        method: 'POST',
                        selector,
                        body: '{"body":"Invoices go out on the 1st."}',
                    }),
                ),
            url: 'http://api.example/memory/facts',
            method: 'POST',
            body: '{"body":"Invoices go out on the 1st."}',
        },
        {
            name: 'GET /facts/stats',
            invoke: (selector) => getStats(request('/api/memory/facts/stats', { selector })),
            url: 'http://api.example/memory/facts/stats',
            method: 'GET',
        },
        {
            name: 'POST /facts/forget-all',
            invoke: (selector) =>
                forgetAll(
                    request('/api/memory/facts/forget-all', {
                        method: 'POST',
                        selector,
                        body: '{"confirm":"FORGET ALL"}',
                    }),
                ),
            url: 'http://api.example/memory/facts/forget-all',
            method: 'POST',
            body: '{"confirm":"FORGET ALL"}',
        },
        {
            name: 'PATCH /facts/:id',
            invoke: (selector) =>
                updateFact(
                    request('/api/memory/facts/f-1', {
                        method: 'PATCH',
                        selector,
                        body: '{"pinned":true}',
                    }),
                    params('f-1'),
                ),
            url: 'http://api.example/memory/facts/f-1',
            method: 'PATCH',
            body: '{"pinned":true}',
        },
        ...(['forget', 'restore', 'accept', 'discard'] as const).map((action) => ({
            name: `POST /facts/:id/${action}`,
            invoke: (selector?: string) => {
                const handler = {
                    forget: forgetFact,
                    restore: restoreFact,
                    accept: acceptFact,
                    discard: discardFact,
                }[action];
                return handler(
                    request(`/api/memory/facts/f-1/${action}`, { method: 'POST', selector }),
                    params('f-1'),
                );
            },
            url: `http://api.example/memory/facts/f-1/${action}`,
            method: 'POST',
        })),
    ];

    it.each(cases)(
        '$name forwards bearer + the per-tab workspace, never the spoofed slug',
        async (c) => {
            const response = await c.invoke('org:ever');

            expect(response.status).toBe(200);
            const { url, init, headers } = upstream();
            expect(url).toBe(c.url);
            expect(init.method).toBe(c.method);
            expect(headers.get(API_SCOPE_HEADER)).toBe('ever');
            expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
            expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
            if (c.body) {
                expect(init.body).toBe(c.body);
                expect(headers.get('Content-Type')).toBe('application/json');
            }
        },
    );

    it.each(cases)('$name fails closed with 400 when the selector is missing', async (c) => {
        const response = await c.invoke(undefined);

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers 401 without an auth cookie and never calls upstream', async () => {
        cookie.token = null;
        const response = await listFacts(request('/api/memory/facts', { selector: 'personal' }));
        expect(response.status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('relays an upstream refusal with its status and message intact', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    statusCode: 409,
                    message: 'Memory is full — 2,000 facts is the limit.',
                }),
                { status: 409, headers: { 'content-type': 'application/json' } },
            ),
        );

        const response = await createFact(
            request('/api/memory/facts', {
                method: 'POST',
                selector: 'personal',
                body: '{"body":"x"}',
            }),
        );

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ message: expect.stringContaining('2,000') });
    });

    it('relays a 204 discard without a body', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

        const response = await discardFact(
            request('/api/memory/facts/f-1/discard', { method: 'POST', selector: 'personal' }),
            params('f-1'),
        );

        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
    });

    it('encodes the id into the upstream path', async () => {
        await forgetFact(
            request('/api/memory/facts/a%2Fb/forget', { method: 'POST', selector: 'personal' }),
            params('a/b'),
        );
        expect(upstream().url).toBe('http://api.example/memory/facts/a%2Fb/forget');
    });
});
