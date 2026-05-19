import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OAuth CSRF state-session binding — pass 18. The OAuth state token
 * issued for User A must NOT be redeemable at the callback by User B
 * (or by an anonymous attacker). Without state→session binding, an
 * attacker can trick a victim into a CSRF attack that links the
 * attacker's third-party identity to the victim's session.
 */

function extractAuthorizeUrl(body: Record<string, unknown> | null): string | null {
    if (!body) return null;
    const url =
        (body.url as string | undefined) ??
        (body.authorize_url as string | undefined) ??
        (body.authorizeUrl as string | undefined);
    return typeof url === 'string' && url.startsWith('http') ? url : null;
}

test.describe("OAuth CSRF — state issued for user A is rejected at user B's callback", () => {
    test("User B cannot redeem User A's state at the github callback", async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        // Alice initiates an OAuth connect.
        const aliceRes = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(alice.access_token),
        });
        if (!aliceRes.ok()) test.skip(true, '/connect/url not available');
        const aliceUrl = extractAuthorizeUrl(await aliceRes.json().catch(() => null));
        if (!aliceUrl) test.skip(true, 'no URL field in connect/url body');
        const aliceState = new URL(aliceUrl).searchParams.get('state');
        if (!aliceState) test.skip(true, 'no state on authorize URL');
        // Bob attempts to redeem Alice's state.
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake-code&state=${encodeURIComponent(aliceState)}`,
            { headers: authedHeaders(bob.access_token) },
        );
        // Acceptable: 4xx rejecting the cross-user redemption.
        // NOT acceptable: 200/2xx with Bob now linked to Alice's
        // pending OAuth flow.
        expect(
            res.status(),
            `Bob redeemed Alice's OAuth state at callback: ${res.status()}`,
        ).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('anonymous (unauth) callback with valid issued state is rejected', async ({ request }) => {
        const alice = await registerUserViaAPI(request);
        const aliceRes = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(alice.access_token),
        });
        if (!aliceRes.ok()) test.skip(true, '/connect/url not available');
        const aliceUrl = extractAuthorizeUrl(await aliceRes.json().catch(() => null));
        if (!aliceUrl) test.skip(true, 'no URL');
        const state = new URL(aliceUrl).searchParams.get('state');
        if (!state) test.skip(true, 'no state');
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake-code&state=${encodeURIComponent(state)}`,
        );
        expect(
            res.status(),
            `unauth callback redeemed Alice's state: ${res.status()}`,
        ).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
