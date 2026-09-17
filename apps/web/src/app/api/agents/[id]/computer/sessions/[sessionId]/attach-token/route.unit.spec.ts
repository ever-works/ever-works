import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

// The shape every shipped deployment with a separately-ingressed API has:
// `API_URL` is the in-cluster address the BFF fetches with (docker-compose.yml
// and every .deploy/k8s web Deployment set exactly this), and it does NOT
// resolve from a user's browser.
vi.mock('@/lib/constants', () => ({
    API_URL: 'http://ever-works-api:3100/api',
}));

import { POST } from './route';

const AGENT = '11111111-2222-4333-8444-555555555555';
const SESSION = '33333333-2222-4333-8444-555555555555';
const WS_PATH = `/ws/computer/${SESSION}`;
const ORIGINAL_PUBLIC = process.env.NEXT_PUBLIC_API_URL;

function request(query = ''): NextRequest {
    return new NextRequest(
        `http://web.example/api/agents/${AGENT}/computer/sessions/${SESSION}/attach-token${query}`,
        {
            method: 'POST',
            headers: new Headers({
                [BROWSER_WORKSPACE_SCOPE_HEADER]: 'org:ever',
                'Content-Type': 'application/json',
            }),
        },
    );
}

const params = () => ({ params: Promise.resolve({ id: AGENT, sessionId: SESSION }) });

/**
 * Agent live view — the socket URL this route hands the browser must be one
 * the BROWSER can dial.
 *
 * `use-computer-attach.ts` calls `new WebSocket(body.wsUrl)` on exactly the
 * string returned here; it never gets to substitute a reachable host. Minting
 * that string from the server-only `API_URL` therefore breaks the live view in
 * every deployment where the API's in-cluster address differs from its public
 * one — DNS fails and the Computer surface renders "cannot connect".
 */
describe('computer attach-token socket origin', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        token: 't',
                        wsPath: WS_PATH,
                        role: 'viewer',
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
        expect(await response.json()).toMatchObject({
            token: 't',
            role: 'viewer',
            expiresInSec: 60,
            wsUrl: `wss://api.ever.works${WS_PATH}`,
        });

        // The upstream fetch still goes to the server-only address — only the
        // URL handed to the browser changes.
        expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
            `http://ever-works-api:3100/api/agents/${AGENT}/computer/sessions/${SESSION}/attach-token`,
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
        // Unchanged from before the fix: a single-origin install where
        // API_URL is itself browser-reachable keeps the URL it always had.
        expect(await response.json()).toMatchObject({
            wsUrl: `ws://ever-works-api:3100${WS_PATH}`,
        });
    });

    it('still forwards only the controller role and still rejects bad ids', async () => {
        process.env.NEXT_PUBLIC_API_URL = 'https://api.ever.works';

        await POST(request('?role=controller'), params());
        expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/attach-token?role=controller');

        await POST(request('?role=worker'), params());
        expect(String(fetchMock.mock.calls.at(-1)?.[0])).not.toContain('role=');

        const bad = await POST(request(), {
            params: Promise.resolve({ id: 'nope', sessionId: SESSION }),
        });
        expect(bad.status).toBe(400);
    });
});
