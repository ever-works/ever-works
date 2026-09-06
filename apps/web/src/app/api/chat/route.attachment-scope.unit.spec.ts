import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/constants', () => ({ API_URL: 'http://api.example' }));
vi.mock('@/lib/auth/cookies', () => ({ getAuthAccessCookie: vi.fn(async () => 'fake-jwt') }));
vi.mock('@/lib/ai/persistence', () => ({ saveConversationMessages: vi.fn(async () => undefined) }));

// `after()` normally defers until the response is flushed. Run the callback
// immediately so the ingest call is observable — that scheduling is exactly why
// the bug existed (Next's `headers()` is gone by then, so the call hand-built
// its headers and forwarded no scope).
vi.mock('next/server', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (fn: () => Promise<void> | void) => {
        void fn();
    },
}));

// The agent runtime is irrelevant here and enormous; short-circuit it.
vi.mock('@/lib/ai/agent', () => ({
    runAgent: vi.fn(async () => ({
        consumeStream: () => undefined,
        toUIMessageStreamResponse: () => new Response('ok', { status: 200 }),
    })),
}));

import { POST } from './route';

/**
 * The chat route's Memory ingest was the last unscoped call in the chat path.
 * #2342 fixed the client transport so `/api/chat` receives the selector, and
 * `serverFetch` picks it up from `headers()` for the tool loop — but this call
 * is a direct `fetch` with hand-built headers inside `after()`, so it forwarded
 * nothing.
 *
 * `OrgMemoryController.ingestFromAttachments` requires an active Organization
 * and answers 422 without one, and the call sits inside an empty `catch`. Every
 * file a member attached inside an Org was therefore silently dropped from that
 * Org's Memory while the chat turn looked completely healthy.
 *
 * These drive the REAL route so they fail if the route stops calling
 * `applyBffWorkspaceScope` — testing the helper alone would pass either way.
 */
describe('POST /api/chat — attachment ingest workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
        fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        delete process.env.WEB_URL;
    });

    function chatRequest(selector?: string) {
        const headers = new Headers({ 'content-type': 'application/json' });
        if (selector) headers.set('x-ever-workspace', selector);
        return new Request('http://web.example/api/chat', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
                providerOverride: 'openai',
                // sha256 shape — `chatBodySchema` constrains attachmentIds to the
                // id the uploads spine issues, so a UUID here is a 400.
                attachmentIds: ['a'.repeat(64)],
            }),
        });
    }

    /** The ingest call, or undefined if the route never made it. */
    function ingestCall() {
        return fetchMock.mock.calls.find((c) =>
            String(c[0]).includes('/memory/uploads/from-attachments'),
        );
    }

    it('forwards the Organization selector on the ingest call', async () => {
        await POST(chatRequest('org:ever'));

        const call = ingestCall();
        expect(call, 'route never issued the ingest call').toBeDefined();
        const headers = new Headers((call?.[1] as RequestInit).headers);
        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
        expect(headers.get('x-ever-workspace')).toBeNull();
    });

    it('forwards the personal sentinel rather than nothing', async () => {
        await POST(chatRequest('personal'));

        const headers = new Headers((ingestCall()?.[1] as RequestInit).headers);
        expect(headers.get('x-scope-slug')).toBe('@personal');
    });

    /**
     * The best-effort half: ingest is an enhancement of the turn, never part of
     * it. A caller with no selector must lose the ingest, not the message.
     */
    it('skips the ingest without failing the turn when no selector is present', async () => {
        const response = await POST(chatRequest());

        expect(response.status).toBe(200);
        expect(ingestCall()).toBeUndefined();
    });
});
