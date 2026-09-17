import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

const getAuthAccessCookie = vi.fn(async (): Promise<string | undefined> => 'fake-jwt');
vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: () => getAuthAccessCookie(),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET } from './route';

const CONVERSATION = '33333333-3333-4333-8333-333333333333';

function request(query: string, headers: Record<string, string> = {}) {
    // A spoofed API scope header rides along: the browser may select a
    // workspace, never name the Organization the API resolves.
    return new NextRequest(`http://web.example/api/conversations/stream${query}`, {
        headers: { [API_SCOPE_HEADER]: 'attacker-supplied', ...headers },
    });
}

/**
 * The docked panel's live delivery. `EventSource` cannot set headers, so the
 * workspace selector travels as `?scope=`; without it every Organization
 * Conversation would 404 on the stream and the panel would sit on its 30 s
 * fallback forever.
 */
describe('GET /api/conversations/stream', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        getAuthAccessCookie.mockResolvedValue('fake-jwt');
        fetchMock = vi.fn(
            async () =>
                new Response('event: message\ndata: {}\n\n', {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('pipes the upstream stream with the Organization scope and bearer token', async () => {
        const response = await GET(request(`?conversationId=${CONVERSATION}&scope=org:ever`));

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        expect(await response.text()).toContain('event: message');

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        // Only the Conversation is forwarded — the carrier is consumed here.
        expect(url).toBe(`http://api.example/conversations/stream?conversationId=${CONVERSATION}`);
        const headers = new Headers(init.headers);
        expect(headers.get(API_SCOPE_HEADER)).toBe('ever');
        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
        expect(init.signal).toBeDefined();
    });

    it('runs personal when no selector is carried', async () => {
        await GET(request(`?conversationId=${CONVERSATION}`));
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get(API_SCOPE_HEADER)).toBe('@personal');
    });

    it('refuses a tampered selector without calling the API', async () => {
        const response = await GET(request(`?conversationId=${CONVERSATION}&scope=org:NOT_A_SLUG`));
        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a missing or malformed Conversation id', async () => {
        expect((await GET(request('?conversationId=nope'))).status).toBe(400);
        expect((await GET(request(''))).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is 401 without a session', async () => {
        getAuthAccessCookie.mockResolvedValue(undefined);
        expect((await GET(request(`?conversationId=${CONVERSATION}`))).status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes an upstream refusal through as a plain status the client falls back on', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
        expect((await GET(request(`?conversationId=${CONVERSATION}`))).status).toBe(404);
    });

    it('answers 502 when the API cannot be reached', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
        expect((await GET(request(`?conversationId=${CONVERSATION}`))).status).toBe(502);
    });
});
