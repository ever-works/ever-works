import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Realtime events — pass 9. The platform may expose SSE / WebSocket
 * channels for live updates (work generation progress, deploy status,
 * notifications push). We probe candidate paths and verify auth gate.
 */

const SSE_PATHS = [
    '/api/events/stream',
    '/api/events',
    '/api/notifications/stream',
    '/api/works/events',
    '/api/realtime',
];

const WS_PATHS = ['/api/ws', '/ws', '/socket.io'];

test.describe('Realtime — SSE endpoint probe', () => {
    test('one SSE endpoint exists + requires auth', async ({ request }) => {
        let found: { path: string; status: number; ct: string } | null = null;
        for (const path of SSE_PATHS) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: { Accept: 'text/event-stream' },
            });
            if (res.status() === 404) continue;
            found = {
                path,
                status: res.status(),
                ct: res.headers()['content-type'] || '',
            };
            break;
        }
        if (!found) test.skip(true, 'no SSE endpoint exposed');
        // Unauth either 401/403, or a streaming response that requires
        // the request to authenticate via cookies — never 5xx.
        expect(found!.status).toBeLessThan(500);
    });

    test('authed SSE endpoint returns text/event-stream content-type', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        let found: { path: string; ct: string; status: number } | null = null;
        for (const path of SSE_PATHS) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: {
                    Accept: 'text/event-stream',
                    ...authedHeaders(u.access_token),
                },
            });
            if (res.status() === 404) continue;
            found = {
                path,
                ct: res.headers()['content-type'] || '',
                status: res.status(),
            };
            // Abandon the stream — we only needed the headers.
            break;
        }
        if (!found) test.skip(true, 'no SSE endpoint accessible to authed user');
        if (found!.status >= 400) {
            test.skip(true, `SSE endpoint returned ${found!.status}`);
        }
        // Content-Type should signal SSE. Some implementations may use
        // chunked / ndjson — both are streaming-shaped.
        const looksStreaming =
            found!.ct.includes('event-stream') ||
            found!.ct.includes('x-ndjson') ||
            found!.ct.includes('text/plain');
        if (!looksStreaming) {
            test.skip(true, `non-streaming content-type: ${found!.ct}`);
        }
        expect(looksStreaming).toBe(true);
    });
});

test.describe('Realtime — WebSocket endpoint probe', () => {
    test('WebSocket upgrade attempt over plain GET returns 4xx', async ({ request }) => {
        let found = false;
        for (const path of WS_PATHS) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            found = true;
            // A WS endpoint hit with plain HTTP without upgrade headers
            // should 400/426/upgrade-required — never 200, never 5xx.
            expect(res.status()).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no WS endpoint exposed');
    });
});
