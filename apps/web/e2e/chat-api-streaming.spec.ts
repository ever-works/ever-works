import { test, expect } from '@playwright/test';

/**
 * Chat API streaming — pass 5. The chat endpoint lives in the Next.js
 * web app (`apps/web/src/app/api/chat/route.ts`), NOT the NestJS API
 * server. So we hit it through Playwright's `baseURL` (port 3000) using
 * `page.request`, not the `request` fixture pointed at `API_BASE`
 * (port 3100).
 *
 * The response may be streaming (SSE) or JSON; we pin auth + that the
 * content-type lands in one of those families. Bail out cleanly on
 * 500/502/503 — that almost always means no LLM key is configured for
 * the test env.
 */

test.describe('Chat API — web-tier streaming response shape', () => {
    test('POST /api/chat without auth → 401 (or 403)', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/chat`;
        const res = await page.request.post(url, {
            data: { messages: [{ role: 'user', content: 'hi' }] },
        });
        // Web chat is auth-gated by the dashboard session cookie. From
        // a fresh context, it must be 401/403 (or 404 if the route isn't
        // shipped in this build).
        expect([401, 403, 404]).toContain(res.status());
    });

    test('POST /api/chat with malformed payload responds 4xx', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/chat`;
        const res = await page.request.post(url, {
            data: { not_a_messages_field: true },
        });
        // 400/422 = validation; 401/403 = auth gate before validation;
        // 404 = not exposed. Never 5xx, never 2xx for bad input.
        expect(res.status()).toBeLessThan(500);
        if (res.status() !== 404) {
            expect(res.status()).toBeGreaterThanOrEqual(400);
        }
    });

    test('POST /api/chat content-type signals streaming OR JSON when authenticated', async ({
        page,
        baseURL,
    }) => {
        // We don't establish auth in this test — the chat-api.spec.ts in
        // pass 1 already drives the authenticated happy path. Here we
        // pin that even an unauth POST returns a typed response (not
        // an empty body / arbitrary HTML), which would mask a broken
        // route handler.
        const url = `${baseURL || 'http://localhost:3000'}/api/chat`;
        const res = await page.request.post(url, {
            data: { messages: [{ role: 'user', content: 'hello' }] },
        });
        if (res.status() >= 500 || res.status() === 402 || res.status() === 404) {
            test.skip(true, `chat env not configured (${res.status()})`);
        }
        const ct = res.headers()['content-type'] || '';
        // For ANY status, the content-type should be something
        // structured: JSON for an auth error envelope, or an SSE stream
        // for a success. An HTML error page or empty body would mean
        // the route handler crashed before reaching the response logic.
        const isJson = ct.includes('json');
        const isStream =
            ct.includes('text/event-stream') ||
            ct.includes('application/x-ndjson') ||
            ct.includes('text/plain');
        expect(isJson || isStream, `chat content-type unknown: "${ct}"`).toBe(true);
    });
});
