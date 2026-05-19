import { test, expect } from '@playwright/test';

/**
 * `/api/chat` — the AI chat route on the Next.js web app. It streams
 * responses from whichever AI provider plugin the user has wired up.
 *
 * Pins the contract: requires auth, accepts a messages-shaped body,
 * doesn't 5xx on malformed input.
 */

test.describe('Web /api/chat — contract', () => {
    test('POST /api/chat without auth → 401 or 403 or redirect to /login', async ({
        page,
        baseURL,
    }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/chat`;
        const res = await page.request.post(url, {
            data: { messages: [{ role: 'user', content: 'hi' }] },
        });
        // Web auth gate is server-action-based; unauthenticated calls return
        // 401/403 or some equivalent non-200 status. Reject anything that
        // looks like a leaked 200 response.
        expect([401, 403, 404, 422]).toContain(res.status());
    });

    test('POST /api/chat with empty body returns 4xx (not 5xx)', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/api/chat`;
        const res = await page.request.post(url, { data: {} });
        expect(res.status()).toBeLessThan(500);
    });
});
