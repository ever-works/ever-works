import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

// Same shape as the live-view sibling: `API_URL` is the in-cluster address the
// BFF fetches with (docker-compose.yml, every .deploy/k8s web Deployment), not
// an address a browser can resolve.
vi.mock('@/lib/constants', () => ({
    API_URL: 'http://ever-works-api:3100/api',
}));

import { POST } from './route';

const AGENT = '11111111-2222-4333-8444-555555555555';
const RUN = '66666666-2222-4333-8444-555555555555';
const WS_PATH = `/ws/terminal/${RUN}`;
const ORIGINAL_PUBLIC = process.env.NEXT_PUBLIC_API_URL;

function request(query = ''): NextRequest {
    return new NextRequest(
        `http://web.example/api/agents/${AGENT}/runs/${RUN}/terminal/attach-token${query}`,
        {
            method: 'POST',
            headers: new Headers({
                [BROWSER_WORKSPACE_SCOPE_HEADER]: 'org:ever',
                'Content-Type': 'application/json',
            }),
        },
    );
}

const params = () => ({ params: Promise.resolve({ id: AGENT, runId: RUN }) });

/**
 * Streaming terminal — the socket URL leg, the live view's exact twin.
 *
 * The terminal pane dials the `wsUrl` this route returns verbatim, so the same
 * in-cluster/public split that breaks the live view breaks the terminal, and
 * it has to be covered on its own route: the two mint their URL in different
 * files and only a test per route keeps them from drifting apart again.
 */
describe('terminal attach-token socket origin', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        token: 't',
                        wsPath: WS_PATH,
                        role: 'operator',
                        expiresInSec: 60,
                    }),
                    { status: 201, headers: { 'Content-Type': 'application/json' } },
                ),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        if (ORIGINAL_PUBLIC === undefined) delete process.env.NEXT_PUBLIC_API_URL;
        else process.env.NEXT_PUBLIC_API_URL = ORIGINAL_PUBLIC;
    });

    it('mints the socket URL on the browser-facing origin, not the in-cluster one', async () => {
        process.env.NEXT_PUBLIC_API_URL = 'https://api.ever.works';

        const response = await POST(request(), params());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            token: 't',
            role: 'operator',
            expiresInSec: 60,
            wsUrl: `wss://api.ever.works${WS_PATH}`,
        });

        // The mint itself still rides the server-only address.
        expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
            `http://ever-works-api:3100/api/agents/${AGENT}/runs/${RUN}/terminal/attach-token`,
        );
    });

    it('strips the /api suffix the e2e workflow puts on the public URL', async () => {
        process.env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3100/api';

        const response = await POST(request(), params());
        expect(await response.json()).toMatchObject({ wsUrl: `ws://127.0.0.1:3100${WS_PATH}` });
    });

    it('falls back to the API_URL origin when no public URL is configured', async () => {
        delete process.env.NEXT_PUBLIC_API_URL;

        const response = await POST(request(), params());
        // Byte-for-byte what this route returned before the fix.
        expect(await response.json()).toMatchObject({
            wsUrl: `ws://ever-works-api:3100${WS_PATH}`,
        });
    });

    it('still forwards only the viewer downgrade and still rejects bad ids', async () => {
        process.env.NEXT_PUBLIC_API_URL = 'https://api.ever.works';

        await POST(request('?role=viewer'), params());
        expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/attach-token?role=viewer');

        await POST(request('?role=operator'), params());
        expect(String(fetchMock.mock.calls.at(-1)?.[0])).not.toContain('role=');

        const bad = await POST(request(), {
            params: Promise.resolve({ id: AGENT, runId: 'nope' }),
        });
        expect(bad.status).toBe(400);
    });

    it('answers 502 for a malformed upstream body and passes an upstream failure through', async () => {
        fetchMock.mockImplementationOnce(
            async () => new Response(JSON.stringify({ token: 't' }), { status: 201 }),
        );
        expect((await POST(request(), params())).status).toBe(502);

        fetchMock.mockImplementationOnce(
            async () => new Response(JSON.stringify({ error: 'gone' }), { status: 409 }),
        );
        const conflict = await POST(request(), params());
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toEqual({ error: 'gone' });
    });
});
