import { test, expect } from '@playwright/test';

/**
 * Sentry error reporting — pass 9. If a Sentry tunnel route is wired
 * (next.config.js `tunnelRoute`), uncaught client errors should be
 * forwarded through it without exposing the DSN.
 *
 * Common tunnel paths: `/monitoring`, `/api/monitoring`,
 * `/_sentry-tunnel`. We probe the candidates and verify either:
 *   - The endpoint returns 200/204 for a POST (tunnel is wired)
 *   - The endpoint 404s (tunnel not wired — fine, skip)
 *
 * What we DON'T accept is a 5xx (broken proxy) or a response that
 * leaks the Sentry DSN/auth-token back to the client.
 */

const TUNNEL_PATHS = ['/monitoring', '/api/monitoring', '/_sentry-tunnel', '/api/sentry-tunnel'];

test.describe('Sentry tunnel — endpoint probe', () => {
    test('tunnel path (if wired) accepts a small envelope without 5xx', async ({
        page,
        baseURL,
    }) => {
        const base = baseURL || 'http://localhost:3000';
        let found = false;
        for (const path of TUNNEL_PATHS) {
            // Sentry envelopes are newline-delimited JSON. We send a
            // minimal three-line envelope: header, item header, payload.
            const envelope = [
                JSON.stringify({
                    event_id: 'e2e0000000000000000000000000000',
                    sent_at: new Date().toISOString(),
                }),
                JSON.stringify({ type: 'event' }),
                JSON.stringify({ message: 'e2e probe', level: 'info' }),
            ].join('\n');
            const res = await page.request.post(`${base}${path}`, {
                headers: { 'Content-Type': 'application/x-sentry-envelope' },
                data: envelope,
            });
            if (res.status() === 404) continue;
            found = true;
            expect(res.status(), `tunnel path ${path} returned 5xx`).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no Sentry tunnel path exposed');
    });

    test('tunnel response body does NOT echo the Sentry DSN', async ({ page, baseURL }) => {
        const base = baseURL || 'http://localhost:3000';
        for (const path of TUNNEL_PATHS) {
            const res = await page.request.post(`${base}${path}`, {
                headers: { 'Content-Type': 'application/x-sentry-envelope' },
                data: '{}\n{}\n{}\n',
            });
            if (res.status() === 404) continue;
            const body = (await res.text()).toLowerCase();
            // A DSN looks like https://<key>@<host>/<project>. We refuse
            // to see that shape in the response body.
            const looksLikeDsn = /https:\/\/[a-f0-9]+@[a-z0-9.-]+\/\d+/i.test(body);
            expect(looksLikeDsn, `Sentry tunnel echoed a DSN back: "${body.slice(0, 200)}"`).toBe(
                false,
            );
            return;
        }
        test.skip(true, 'no Sentry tunnel path');
    });
});

test.describe('Sentry — client SDK does not run on auth pages without consent', () => {
    test('login page does not preemptively send to a Sentry origin', async ({ page, baseURL }) => {
        const sentryHits: string[] = [];
        page.on('request', (req) => {
            const url = req.url();
            if (/sentry|ingest\.sentry\.io|@sentry/.test(url)) {
                sentryHits.push(url);
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        // We allow Sentry's INIT requests (the SDK bootstrapping itself);
        // we just want to make sure no obvious event-capture happens on
        // an empty login page (no user → no captured events).
        const eventCaptures = sentryHits.filter((u) => /api\/\d+\/envelope/.test(u));
        expect(
            eventCaptures.length,
            `login page captured Sentry events: ${eventCaptures.join(', ')}`,
        ).toBe(0);
    });
});
