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
        // Codex P1: a bare 4xx assertion isn't enough — the same 4xx
        // would also fire when an INVALID `code` is exchanged with a
        // VALID state. To prove state→session binding actually
        // happens, compare:
        //  (A) Bob's session + Alice's state + fake code
        //  (B) Alice's session + Alice's state + fake code
        // If state-binding works, (A) is rejected by the state guard
        // BEFORE the code exchange runs — that should produce a
        // different status or error shape than (B), which gets past
        // state and fails at the code exchange.
        const bobAttempt = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake-code&state=${encodeURIComponent(aliceState)}`,
            { headers: authedHeaders(bob.access_token) },
        );
        expect(
            bobAttempt.status(),
            `Bob redeemed Alice's OAuth state at callback: ${bobAttempt.status()}`,
        ).toBeGreaterThanOrEqual(400);
        expect(bobAttempt.status()).toBeLessThan(500);
        // Re-issue Alice's state for the (B) probe — the (A) attempt
        // above may have consumed the original.
        const aliceRes2 = await request.get(`${API_BASE}/api/oauth/github/connect/url`, {
            headers: authedHeaders(alice.access_token),
        });
        if (!aliceRes2.ok()) test.skip(true, 'second /connect/url failed');
        const aliceUrl2 = extractAuthorizeUrl(await aliceRes2.json().catch(() => null));
        if (!aliceUrl2) test.skip(true, 'no URL in second connect/url');
        const aliceState2 = new URL(aliceUrl2).searchParams.get('state');
        if (!aliceState2) test.skip(true, 'no state on second connect/url');
        const aliceAttempt = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=fake-code&state=${encodeURIComponent(aliceState2)}`,
            { headers: authedHeaders(alice.access_token) },
        );
        // The differentiator: when Bob uses Alice's state, the state
        // guard should fail FIRST — typically a 401/403 or a body
        // mentioning state/csrf/forbidden. When Alice uses her own
        // state, the state guard passes and the code exchange fails
        // — typically a 400/502 or a body mentioning code/exchange.
        // The two responses should NOT be identical at both status
        // and body level; that would mean the state isn't actually
        // checked.
        const bobBody = await bobAttempt.text();
        const aliceBody = await aliceAttempt.text();
        const identicalStatus = bobAttempt.status() === aliceAttempt.status();
        const identicalBody = bobBody === aliceBody;
        expect(
            identicalStatus && identicalBody,
            `state-binding regression suspected: Bob's cross-user state attempt and Alice's own-state attempt produced identical responses (status=${bobAttempt.status()}, body matches)`,
        ).toBe(false);
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
