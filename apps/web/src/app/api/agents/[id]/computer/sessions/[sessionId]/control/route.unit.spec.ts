import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { DELETE, GET, POST } from './route';
import { POST as HANDOVER } from './handover/route';
import { POST as KEEP } from './keep/route';
import { POST as EXTEND } from './extend/route';
import { POST as ATTACH_TOKEN } from '../attach-token/route';

const AGENT = '11111111-2222-4333-8444-555555555555';
const SESSION = '33333333-2222-4333-8444-555555555555';
const OTHER_VIEW = '44444444-2222-4333-8444-555555555555';
const BASE = `http://api.example/agents/${AGENT}/computer/sessions/${SESSION}`;

function request(
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' },
): NextRequest {
    return new NextRequest(
        `http://web.example/api/agents/${AGENT}/computer/sessions/${SESSION}${path}`,
        {
            method: init.method,
            headers: new Headers({
                [BROWSER_WORKSPACE_SCOPE_HEADER]: 'org:ever',
                'Content-Type': 'application/json',
            }),
            ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        },
    );
}

const params = (id = AGENT, sessionId = SESSION) => ({
    params: Promise.resolve({ id, sessionId }),
});

/**
 * The control BFF routes: thin, scope-carrying forwards whose bodies are
 * rebuilt from an allow-list, whose ids are checked before anything leaves
 * the web tier, and whose status (403 policy, 409 held) passes through
 * untouched — plus the attach-token route, which forwards exactly one role.
 */
describe('computer control BFF routes', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ reason: 'held', holder: { sessionId: OTHER_VIEW } }),
                    {
                        status: 409,
                        headers: { 'Content-Type': 'application/json' },
                    },
                ),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];

    it('reads control state with the workspace scope', async () => {
        await GET(request('/control'), params());
        const [url, init] = lastCall();
        expect(url).toBe(`${BASE}/control`);
        expect(init.method).toBe('GET');
        expect(new Headers(init.headers).get(API_SCOPE_HEADER)).toBe('ever');
    });

    it('takes control with an empty body, asks with request: true, and drops anything else', async () => {
        const response = await POST(
            request('/control', {
                method: 'POST',
                body: { request: 'yes', role: 'driver', holder: 'me' },
            }),
            params(),
        );
        expect(JSON.parse(String(lastCall()[1].body))).toEqual({});
        // The platform's refusal, reason and holder pass through unchanged.
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
            reason: 'held',
            holder: { sessionId: OTHER_VIEW },
        });

        await POST(request('/control', { method: 'POST', body: { request: true } }), params());
        expect(JSON.parse(String(lastCall()[1].body))).toEqual({ request: true });
    });

    it('gives control back, keeps and extends on their own routes', async () => {
        await DELETE(request('/control', { method: 'DELETE' }), params());
        expect(lastCall()[0]).toBe(`${BASE}/control`);
        expect(lastCall()[1].method).toBe('DELETE');
        await KEEP(request('/control/keep', { method: 'POST' }), params());
        expect(lastCall()[0]).toBe(`${BASE}/control/keep`);
        await EXTEND(request('/control/extend', { method: 'POST' }), params());
        expect(lastCall()[0]).toBe(`${BASE}/control/extend`);
    });

    it('forwards a hand-over answer only when both fields are valid', async () => {
        const bad = await HANDOVER(
            request('/control/handover', {
                method: 'POST',
                body: { requestId: 'x', decision: 'hand-over' },
            }),
            params(),
        );
        expect(bad.status).toBe(400);
        const worse = await HANDOVER(
            request('/control/handover', {
                method: 'POST',
                body: { requestId: OTHER_VIEW, decision: 'steal' },
            }),
            params(),
        );
        expect(worse.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();

        await HANDOVER(
            request('/control/handover', {
                method: 'POST',
                body: { requestId: OTHER_VIEW, decision: 'hand-over', extra: true },
            }),
            params(),
        );
        expect(lastCall()[0]).toBe(`${BASE}/control/handover`);
        expect(JSON.parse(String(lastCall()[1].body))).toEqual({
            requestId: OTHER_VIEW,
            decision: 'hand-over',
        });
    });

    it('checks both ids before anything leaves the web tier', async () => {
        expect((await GET(request('/control'), params('nope'))).status).toBe(400);
        expect(
            (await POST(request('/control', { method: 'POST', body: {} }), params(AGENT, 'nope')))
                .status,
        ).toBe(400);
        expect(
            (await KEEP(request('/control/keep', { method: 'POST' }), params('nope'))).status,
        ).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forwards the controller role to the attach token only when asked for exactly that', async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        token: 't',
                        wsPath: `/ws/computer/${SESSION}`,
                        role: 'driver',
                    }),
                    {
                        status: 201,
                        headers: { 'Content-Type': 'application/json' },
                    },
                ),
        );
        await ATTACH_TOKEN(request('/attach-token', { method: 'POST' }), params());
        expect(lastCall()[0]).toBe(`${BASE}/attach-token`);

        await ATTACH_TOKEN(request('/attach-token?role=worker', { method: 'POST' }), params());
        expect(lastCall()[0]).toBe(`${BASE}/attach-token`);

        const response = await ATTACH_TOKEN(
            request('/attach-token?role=controller', { method: 'POST' }),
            params(),
        );
        expect(lastCall()[0]).toBe(`${BASE}/attach-token?role=controller`);
        expect(await response.json()).toMatchObject({
            token: 't',
            role: 'driver',
            wsUrl: `ws://api.example/ws/computer/${SESSION}`,
        });
    });
});
