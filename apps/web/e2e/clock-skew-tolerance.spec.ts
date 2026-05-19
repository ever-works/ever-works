import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Clock skew tolerance — pass 13. JWT validators should accept tokens
 * minted ~30 seconds out of sync to handle real-world NTP drift across
 * machines. The platform's token validator must NOT reject a token
 * whose iat is slightly in the future (within ~60s) or whose nbf
 * boundary just passed.
 *
 * We can't easily mint a JWT with a skewed iat here. Instead we pin
 * the contract: a freshly-issued token works immediately (no nbf
 * delay), and a token used in rapid succession doesn't 401 from a
 * timing race.
 */

test.describe('Clock skew — token usable immediately on mint', () => {
    test('access_token works on first request right after register', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Use the token immediately — no setTimeout / clock-warming
        // pause. If the validator had a strict nbf future-window, this
        // would 401.
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status(), `immediate use of fresh token returned ${res.status()}`).toBe(200);
    });

    test('token works on 5 consecutive fast requests (no clock-window false-rejects)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        for (let i = 0; i < 5; i++) {
            const res = await request.get(`${API_BASE}/api/auth/profile`, {
                headers: authedHeaders(u.access_token),
            });
            expect(res.status(), `iteration ${i}: ${res.status()}`).toBe(200);
        }
    });
});

test.describe('Clock skew — server time visible (sanity)', () => {
    test('GET /api/health Date header is within 5 minutes of test runner now', async ({
        request,
    }) => {
        const before = Date.now();
        const res = await request.get(`${API_BASE}/api/health`);
        const dateHeader = res.headers()['date'];
        if (!dateHeader) test.skip(true, 'no Date header on health response');
        const serverTime = Date.parse(dateHeader!);
        const after = Date.now();
        // The server's clock should be within ~5 minutes of ours.
        // Anything beyond that is either misconfigured NTP on either
        // end, or worth flagging.
        const skew = Math.min(Math.abs(serverTime - before), Math.abs(serverTime - after));
        expect(skew, `server-client clock skew ${skew}ms — check NTP on either side`).toBeLessThan(
            5 * 60 * 1000,
        );
    });
});
